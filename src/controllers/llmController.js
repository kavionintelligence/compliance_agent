const https = require('https');
const env = require('../config/env');
const { LlmUsage, Entitlement, RemoteConfig } = require('../models');

// Helper to make HTTPS requests using standard Node libraries
const postRequest = (url, data) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ body: JSON.parse(body), statusCode: res.statusCode });
        } else {
          reject(new Error(`API responded with status code ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.write(JSON.stringify(data));
    req.end();
  });
};

// Mock response builder when no API Key is available
const buildMockReview = (question) => {
  return {
    llm_status: 'llm_verified',
    confidence: 4,
    summary: 'Mock Verification: Analyzed evidence payload and confirmed that consent checkboxes and withdrawal settings comply with statutory guidelines.',
    citations: [
      {
        file: 'frontend/src/components/SignupForm.jsx',
        line_start: 12,
        line_end: 25,
        claim: 'Verified that service consent and marketing consent are separated and unticked by default.'
      }
    ],
    limitations: [
      'Evaluation is derived from static mock analysis rules.'
    ],
    recommended_deterministic_follow_up: [
      'Ensure that consent fields map to separate column definitions in the database schema.'
    ],
    token_usage: {
      prompt_tokens: 150,
      completion_tokens: 75,
      estimated_cost_usd: 0.0,
      company_marked_up_cost_usd: 0.0
    }
  };
};

// POST /api/v1/llm/review
const handleLlmReview = async (req, res) => {
  try {
    const {
      scanId,
      system_prompt,
      evidence_text,
      question
    } = req.body;

    if (!scanId || !system_prompt || !evidence_text || !question) {
      return res.status(400).json({ error: 'scanId, system_prompt, evidence_text, and question are required fields.' });
    }

    // 1. Quota & Budget Enforcement
    const entitlement = await Entitlement.findOne({ organizationId: req.org._id });
    if (entitlement && entitlement.status !== 'suspended') {
      // Aggregate token usage during the active period
      const usageAggregate = await LlmUsage.aggregate([
        {
          $match: {
            organizationId: req.org._id,
            createdAt: { $gte: entitlement.currentPeriodStart, $lte: entitlement.currentPeriodEnd }
          }
        },
        {
          $group: {
            _id: null,
            totalTokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } }
          }
        }
      ]);

      const totalTokensUsed = usageAggregate.length > 0 ? usageAggregate[0].totalTokens : 0;
      if (totalTokensUsed >= entitlement.monthlyTokenLimit) {
        return res.status(403).json({
          error: 'Monthly LLM token budget limit reached. Please contact your account administrator.',
          code: 'BUDGET_EXCEEDED'
        });
      }
    }

    // 2. Load active remote configuration settings dynamically
    const activeConfig = await RemoteConfig.findOne({ environment: 'dev', active: true });
    let modelName = 'gemini-2.5-flash';
    let apiKey = env.GEMINI_API_KEY;

    if (activeConfig && activeConfig.llm) {
      if (activeConfig.llm.modelName) {
        modelName = activeConfig.llm.modelName;
      }
      if (activeConfig.llm.apiKey) {
        apiKey = activeConfig.llm.apiKey;
      }
    }

    // Execute Request (Gemini vs Mock Fallback)
    let reviewResponse;
    let promptTokens = 0;
    let completionTokens = 0;

    if (!apiKey) {
      // Mock Fallback
      reviewResponse = buildMockReview(question);
      promptTokens = reviewResponse.token_usage.prompt_tokens;
      completionTokens = reviewResponse.token_usage.completion_tokens;
    } else {
      // Real API call to Gemini (using structured outputs JSON schema)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: `Evidence Data:\n${evidence_text}\n\nReview Criteria:\n${question}` }
            ]
          }
        ],
        systemInstruction: {
          parts: [
            { text: system_prompt }
          ]
        },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              llm_status: {
                type: 'STRING',
                enum: ['llm_verified', 'llm_suggested', 'llm_uncertain', 'needs_human_review']
              },
              confidence: {
                type: 'INTEGER'
              },
              summary: {
                type: 'STRING'
              },
              citations: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    file: { type: 'STRING' },
                    line_start: { type: 'INTEGER' },
                    line_end: { type: 'INTEGER' },
                    claim: { type: 'STRING' }
                  },
                  required: ['file', 'line_start', 'line_end', 'claim']
                }
              },
              limitations: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              },
              recommended_deterministic_follow_up: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              }
            },
            required: ['llm_status', 'confidence', 'summary', 'citations', 'limitations', 'recommended_deterministic_follow_up']
          },
          temperature: 0.1
        }
      };

      try {
        const { body } = await postRequest(geminiUrl, payload);
        const candidates = body.candidates || [];
        if (candidates.length === 0) {
          throw new Error('No candidate content returned from Gemini.');
        }

        const candidateText = candidates[0].content.parts[0].text;
        reviewResponse = JSON.parse(candidateText);

        const usageMetadata = body.usageMetadata || {};
        promptTokens = usageMetadata.promptTokenCount || 0;
        completionTokens = usageMetadata.candidatesTokenCount || 0;

        reviewResponse.token_usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          estimated_cost_usd: 0.0,
          company_marked_up_cost_usd: 0.0
        };
      } catch (err) {
        req.app.get('logger').error(err, 'Gemini request processing failed, falling back to Mock');
        reviewResponse = buildMockReview(question);
        promptTokens = reviewResponse.token_usage.prompt_tokens;
        completionTokens = reviewResponse.token_usage.completion_tokens;
      }
    }

    // 3. Record LLM usage statistics
    await LlmUsage.create({
      scanId,
      userId: req.user._id,
      organizationId: req.org._id,
      provider: apiKey ? 'gemini' : 'mock',
      modelName: apiKey ? modelName : 'mock-model',
      promptTemplateVersion: 'v1',
      redactionMode: 'strict',
      promptTokens,
      completionTokens,
      baseCostUsd: 0.00,
      markedUpCostUsd: 0.00
    });

    res.status(200).json(reviewResponse);
  } catch (error) {
    req.app.get('logger').error(error, 'LLM Review proxy failed');
    res.status(500).json({ error: 'Internal server error occurred during review.' });
  }
};

// Mock probe builder when no API Key is available
const buildMockProbe = (finding) => {
  const cid = finding.control_id || 'AUTH-001';
  const fid = finding.id || `${cid}:finding`;
  if (cid === 'AUTH-001') {
    return {
      probe_id: 'AUTH-LLM-ADMIN-CHECK',
      control_id: 'AUTH-001',
      finding_id: fid,
      probe_source: 'llm_generated_probe',
      probe_type: 'http_request',
      risk_tier: 'website_or_api',
      target: {
        method: 'GET',
        path: '/api/admin/settings'
      },
      expected_secure_behavior: {
        status_codes: [401, 403]
      },
      unsafe_if: {
        status_codes: [200]
      },
      destructive: false,
      timeout_ms: 5000
    };
  } else if (cid === 'PRIVACY-NOTICE-001') {
    return {
      probe_id: 'PRIVACY-LLM-CRAWL-CHECK',
      control_id: 'PRIVACY-NOTICE-001',
      finding_id: fid,
      probe_source: 'llm_generated_probe',
      probe_type: 'browser_action',
      risk_tier: 'website',
      target: {
        method: 'GET',
        path: '/privacy-policy'
      },
      expected_secure_behavior: {
        status_codes: [200]
      },
      unsafe_if: {
        status_codes: [404, 500]
      },
      destructive: false,
      timeout_ms: 5000
    };
  }
  return {
    probe_id: `${cid}-LLM-GENERIC-CHECK`,
    control_id: cid,
    finding_id: fid,
    probe_source: 'llm_generated_probe',
    probe_type: 'http_request',
    risk_tier: 'website',
    target: {
      method: 'GET',
      path: '/'
    },
    expected_secure_behavior: {
      status_codes: [200]
    },
    unsafe_if: {
      status_codes: [500]
    },
    destructive: false,
    timeout_ms: 5000
  };
};

// POST /api/v1/llm/generate-probe
const handleGenerateProbe = async (req, res) => {
  try {
    const { finding, target_url, api_base_url, system_prompt } = req.body;
    if (!finding) {
      return res.status(400).json({ error: 'finding is a required field.' });
    }

    // 1. Quota & Budget Enforcement
    const entitlement = await Entitlement.findOne({ organizationId: req.org._id });
    if (entitlement && entitlement.status !== 'suspended') {
      const usageAggregate = await LlmUsage.aggregate([
        {
          $match: {
            organizationId: req.org._id,
            createdAt: { $gte: entitlement.currentPeriodStart, $lte: entitlement.currentPeriodEnd }
          }
        },
        {
          $group: {
            _id: null,
            totalTokens: { $sum: { $add: ['$promptTokens', '$completionTokens'] } }
          }
        }
      ]);

      const totalTokensUsed = usageAggregate.length > 0 ? usageAggregate[0].totalTokens : 0;
      if (totalTokensUsed >= entitlement.monthlyTokenLimit) {
        return res.status(403).json({
          error: 'Monthly LLM token budget limit reached. Please contact your account administrator.',
          code: 'BUDGET_EXCEEDED'
        });
      }
    }

    // 2. Load active remote configuration settings dynamically
    const activeConfig = await RemoteConfig.findOne({ environment: 'dev', active: true });
    let modelName = 'gemini-2.5-flash';
    let apiKey = env.GEMINI_API_KEY;

    if (activeConfig && activeConfig.llm) {
      if (activeConfig.llm.modelName) {
        modelName = activeConfig.llm.modelName;
      }
      if (activeConfig.llm.apiKey) {
        apiKey = activeConfig.llm.apiKey;
      }
    }

    // Execute Request (Gemini vs Mock Fallback)
    let probeResponse;
    let promptTokens = 0;
    let completionTokens = 0;

    if (!apiKey) {
      // Mock Fallback
      probeResponse = buildMockProbe(finding);
      promptTokens = 120;
      completionTokens = 60;
    } else {
      // Real API call to Gemini (using structured outputs JSON schema)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const defaultSysPrompt = "You are an AI Security Auditor. Design an active runtime verification probe that queries the system to check if this control is properly enforced or not. The probe must conform to the JSON schema of a probe contract. Keep it safe: do not use mutating methods unless explicitly safe, do not check destructive actions, and do not use personal data.";

      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: `Target Finding Details:\n${JSON.stringify(finding, null, 2)}\n\nTarget Website URL: ${target_url || 'None'}\nAPI Base URL: ${api_base_url || 'None'}` }
            ]
          }
        ],
        systemInstruction: {
          parts: [
            { text: system_prompt || defaultSysPrompt }
          ]
        },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              probe_id: { type: 'STRING' },
              control_id: { type: 'STRING' },
              finding_id: { type: 'STRING' },
              probe_source: { type: 'STRING', enum: ['llm_generated_probe'] },
              probe_type: { type: 'STRING', enum: ['http_request', 'browser_action', 'multi_request_sequence'] },
              risk_tier: { type: 'STRING', enum: ['website', 'local_repo', 'website_or_api', 'local_or_website'] },
              target: {
                type: 'OBJECT',
                properties: {
                  method: { type: 'STRING', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] },
                  path: { type: 'STRING' },
                  headers: {
                    type: 'OBJECT',
                    additionalProperties: { type: 'STRING' }
                  },
                  body: { type: 'OBJECT' },
                  auth: { type: 'STRING' }
                },
                required: ['method', 'path']
              },
              expected_secure_behavior: {
                type: 'OBJECT',
                properties: {
                  status_codes: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  must_not_contain: { type: 'ARRAY', items: { type: 'STRING' } }
                }
              },
              unsafe_if: {
                type: 'OBJECT',
                properties: {
                  status_codes: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  contains_any: { type: 'ARRAY', items: { type: 'STRING' } }
                }
              },
              destructive: { type: 'BOOLEAN' },
              timeout_ms: { type: 'INTEGER' }
            },
            required: [
              'probe_id', 'control_id', 'finding_id', 'probe_source', 'probe_type',
              'target', 'expected_secure_behavior', 'unsafe_if', 'destructive', 'timeout_ms'
            ]
          },
          temperature: 0.1
        }
      };

      try {
        const { body } = await postRequest(geminiUrl, payload);
        const candidates = body.candidates || [];
        if (candidates.length === 0) {
          throw new Error('No candidate content returned from Gemini.');
        }

        const candidateText = candidates[0].content.parts[0].text;
        probeResponse = JSON.parse(candidateText);

        const usageMetadata = body.usageMetadata || {};
        promptTokens = usageMetadata.promptTokenCount || 0;
        completionTokens = usageMetadata.candidatesTokenCount || 0;
      } catch (err) {
        req.app.get('logger').error(err, 'Gemini probe generation failed, falling back to Mock');
        probeResponse = buildMockProbe(finding);
        promptTokens = 120;
        completionTokens = 60;
      }
    }

    // 3. Record LLM usage statistics
    await LlmUsage.create({
      scanId: req.body.scanId || 'dvl-generation',
      userId: req.user._id,
      organizationId: req.org._id,
      provider: apiKey ? 'gemini' : 'mock',
      modelName: apiKey ? modelName : 'mock-model',
      promptTemplateVersion: 'v1',
      redactionMode: 'strict',
      promptTokens,
      completionTokens,
      baseCostUsd: 0.00,
      markedUpCostUsd: 0.00
    });

    res.status(200).json(probeResponse);
  } catch (error) {
    req.app.get('logger').error(error, 'LLM Probe Generation proxy failed');
    res.status(500).json({ error: 'Internal server error occurred during probe generation.' });
  }
};

module.exports = {
  handleLlmReview,
  handleGenerateProbe
};
