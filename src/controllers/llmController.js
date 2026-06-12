const { GoogleGenAI } = require('@google/genai');
const os = require('os');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { LlmUsage, Entitlement, RemoteConfig } = require('../models');

// Write GCP credentials to a temp file so the SDK can find them via
// GOOGLE_APPLICATION_CREDENTIALS.  Works for both authorized_user (ADC /
// user OAuth2) and service_account JSON types.
(function bootstrapCredentials() {
  const jsonCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (jsonCredentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const tmpFile = path.join(os.tmpdir(), 'gcp-credentials.json');
      fs.writeFileSync(tmpFile, jsonCredentials, { encoding: 'utf8', mode: 0o600 });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
    } catch (err) {
      console.error('[llmController] Failed to write GCP credentials:', err.message);
    }
  }
})();

// ---------------------------------------------------------------------------
// Build a GoogleGenAI client in Vertex AI mode.
// Auth: GOOGLE_APPLICATION_CREDENTIALS (Vercel) or ambient ADC (local).
// ---------------------------------------------------------------------------
function buildAiClient() {
  return new GoogleGenAI({
    vertexai: true,
    project: env.VERTEX_PROJECT,
    location: env.VERTEX_LOCATION,
  });
}

// ---------------------------------------------------------------------------
// Resolve the active model name from Remote Config.
// ---------------------------------------------------------------------------
const getActiveLlmSettings = async () => {
  const candidates = [process.env.CONFIG_ENV, 'production', 'dev'].filter(Boolean);
  let modelName = 'gemini-2.5-pro';

  for (const environment of candidates) {
    const activeConfig = await RemoteConfig.findOne({ environment, active: true });
    if (activeConfig?.llm?.modelName) {
      modelName = String(activeConfig.llm.modelName).trim();
      break;
    }
  }
  return { modelName };
};

// ---------------------------------------------------------------------------
// POST /api/v1/llm/review
// ---------------------------------------------------------------------------
const handleLlmReview = async (req, res) => {
  try {
    const { scanId, system_prompt, evidence_text, question } = req.body;

    if (!scanId || !system_prompt || !evidence_text || !question) {
      return res.status(400).json({
        error: 'scanId, system_prompt, evidence_text, and question are required.',
      });
    }

    // 1. Budget enforcement
    const entitlement = await Entitlement.findOne({ organizationId: req.org._id });
    if (entitlement && entitlement.status !== 'suspended') {
      const usageAggregate = await LlmUsage.aggregate([
        {
          $match: {
            organizationId: req.org._id,
            createdAt: { $gte: entitlement.currentPeriodStart, $lte: entitlement.currentPeriodEnd },
          },
        },
        { $group: { _id: null, totalTokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } } } },
      ]);
      const totalTokensUsed = usageAggregate.length > 0 ? usageAggregate[0].totalTokens : 0;
      if (totalTokensUsed >= entitlement.monthlyTokenLimit) {
        return res.status(403).json({ error: 'Monthly LLM token budget limit reached.', code: 'BUDGET_EXCEEDED' });
      }
    }

    // 2. Resolve model name from Remote Config
    const { modelName } = await getActiveLlmSettings();

    // 3. Call Vertex AI via @google/genai SDK (auth is ambient via ADC / service account)
    let reviewResponse;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const ai = buildAiClient();
      const result = await ai.models.generateContent({
        model: modelName,
        contents: `Evidence Data:\n${evidence_text}\n\nReview Criteria:\n${question}`,
        config: {
          systemInstruction: system_prompt,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              llm_status: {
                type: 'STRING',
                enum: ['llm_verified', 'llm_suggested', 'llm_uncertain', 'needs_human_review'],
              },
              confidence: { type: 'INTEGER' },
              summary: { type: 'STRING' },
              citations: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    file: { type: 'STRING' },
                    line_start: { type: 'INTEGER' },
                    line_end: { type: 'INTEGER' },
                    claim: { type: 'STRING' },
                  },
                  required: ['file', 'line_start', 'line_end', 'claim'],
                },
              },
              limitations: { type: 'ARRAY', items: { type: 'STRING' } },
              recommended_deterministic_follow_up: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: [
              'llm_status', 'confidence', 'summary',
              'citations', 'limitations', 'recommended_deterministic_follow_up',
            ],
          },
        },
      });

      const text = result.text;
      if (!text) throw new Error('No text returned from Vertex AI.');

      reviewResponse = JSON.parse(text);

      const usage = result.usageMetadata || {};
      promptTokens = usage.promptTokenCount || 0;
      completionTokens = usage.candidatesTokenCount || 0;

      reviewResponse.token_usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        estimated_cost_usd: 0.0,
        company_marked_up_cost_usd: 0.0,
      };
    } catch (err) {
      req.app.get('logger').error(err, 'Vertex AI review request failed');
      // Never substitute a fabricated review — surface the failure.
      return res.status(502).json({
        error: 'The upstream LLM request failed. The review was not performed.',
        code: 'LLM_UPSTREAM_ERROR',
      });
    }

    // 4. Record usage
    await LlmUsage.create({
      scanId,
      userId: req.user._id,
      organizationId: req.org._id,
      provider: 'gemini',
      modelName,
      promptTemplateVersion: 'v1',
      redactionMode: 'strict',
      promptTokens,
      completionTokens,
      baseCostUsd: 0.0,
      markedUpCostUsd: 0.0,
    });

    res.status(200).json(reviewResponse);
  } catch (error) {
    req.app.get('logger').error(error, 'LLM Review proxy failed');
    res.status(500).json({ error: 'Internal server error during review.' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/llm/generate-probe
// ---------------------------------------------------------------------------
const handleGenerateProbe = async (req, res) => {
  try {
    const { finding, target_url, api_base_url, system_prompt } = req.body;
    if (!finding) {
      return res.status(400).json({ error: 'finding is a required field.' });
    }

    // 1. Budget enforcement
    const entitlement = await Entitlement.findOne({ organizationId: req.org._id });
    if (entitlement && entitlement.status !== 'suspended') {
      const usageAggregate = await LlmUsage.aggregate([
        {
          $match: {
            organizationId: req.org._id,
            createdAt: { $gte: entitlement.currentPeriodStart, $lte: entitlement.currentPeriodEnd },
          },
        },
        { $group: { _id: null, totalTokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } } } },
      ]);
      const totalTokensUsed = usageAggregate.length > 0 ? usageAggregate[0].totalTokens : 0;
      if (totalTokensUsed >= entitlement.monthlyTokenLimit) {
        return res.status(403).json({ error: 'Monthly LLM token budget limit reached.', code: 'BUDGET_EXCEEDED' });
      }
    }

    // 2. Resolve model name
    const { modelName } = await getActiveLlmSettings();

    // 3. Call Vertex AI via @google/genai SDK
    let probeResponse;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const defaultSysPrompt =
        'You are an AI Security Auditor. Design an active runtime verification probe ' +
        'that queries the system to check if this control is properly enforced. ' +
        'The probe must conform to the JSON schema of a probe contract. ' +
        'Keep it safe: no mutating methods unless explicitly safe, no destructive actions, no personal data.';

      const ai = buildAiClient();
      const result = await ai.models.generateContent({
        model: modelName,
        contents:
          `Target Finding Details:\n${JSON.stringify(finding, null, 2)}\n\n` +
          `Target Website URL: ${target_url || 'None'}\n` +
          `API Base URL: ${api_base_url || 'None'}`,
        config: {
          systemInstruction: system_prompt || defaultSysPrompt,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              probe_id: { type: 'STRING' },
              control_id: { type: 'STRING' },
              finding_id: { type: 'STRING' },
              probe_source: { type: 'STRING', enum: ['llm_generated_probe'] },
              probe_type: {
                type: 'STRING',
                enum: ['http_request', 'browser_action', 'multi_request_sequence'],
              },
              risk_tier: {
                type: 'STRING',
                enum: ['website', 'local_repo', 'website_or_api', 'local_or_website'],
              },
              target: {
                type: 'OBJECT',
                properties: {
                  method: { type: 'STRING', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] },
                  path: { type: 'STRING' },
                  headers: { type: 'OBJECT', additionalProperties: { type: 'STRING' } },
                  body: { type: 'OBJECT' },
                  auth: { type: 'STRING' },
                },
                required: ['method', 'path'],
              },
              expected_secure_behavior: {
                type: 'OBJECT',
                properties: {
                  status_codes: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  must_not_contain: { type: 'ARRAY', items: { type: 'STRING' } },
                },
              },
              unsafe_if: {
                type: 'OBJECT',
                properties: {
                  status_codes: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  contains_any: { type: 'ARRAY', items: { type: 'STRING' } },
                },
              },
              destructive: { type: 'BOOLEAN' },
              timeout_ms: { type: 'INTEGER' },
            },
            required: [
              'probe_id', 'control_id', 'finding_id', 'probe_source', 'probe_type',
              'target', 'expected_secure_behavior', 'unsafe_if', 'destructive', 'timeout_ms',
            ],
          },
        },
      });

      const text = result.text;
      if (!text) throw new Error('No text returned from Vertex AI.');

      probeResponse = JSON.parse(text);

      const usage = result.usageMetadata || {};
      promptTokens = usage.promptTokenCount || 0;
      completionTokens = usage.candidatesTokenCount || 0;
    } catch (err) {
      req.app.get('logger').error(err, 'Vertex AI probe generation failed');
      return res.status(502).json({
        error: 'The upstream LLM request failed. No probe was generated.',
        code: 'LLM_UPSTREAM_ERROR',
      });
    }

    // 4. Record usage
    await LlmUsage.create({
      scanId: req.body.scanId || 'dvl-generation',
      userId: req.user._id,
      organizationId: req.org._id,
      provider: 'gemini',
      modelName,
      promptTemplateVersion: 'v1',
      redactionMode: 'strict',
      promptTokens,
      completionTokens,
      baseCostUsd: 0.0,
      markedUpCostUsd: 0.0,
    });

    res.status(200).json(probeResponse);
  } catch (error) {
    req.app.get('logger').error(error, 'LLM Probe Generation proxy failed');
    res.status(500).json({ error: 'Internal server error during probe generation.' });
  }
};

module.exports = { handleLlmReview, handleGenerateProbe };
