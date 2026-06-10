const { RemoteConfig } = require('../models');

// GET /api/v1/config/client
// Dynamic environment configuration lookup
const getClientConfig = async (req, res) => {
  try {
    const environmentName = req.query.env || 'production';

    const config = await RemoteConfig.findOne({
      environment: environmentName,
      active: true
    }).select('-__v -createdAt -updatedAt -updatedBy');

    if (!config) {
      return res.status(404).json({ error: 'Active dynamic configuration not found for the requested environment.' });
    }

    // SECURITY: this endpoint is public (apps poll it before login). The LLM
    // API key must NEVER leave the server — the whole point of the proxy.
    const safe = config.toObject();
    if (safe.llm) {
      safe.llm = { ...safe.llm, apiKeyConfigured: Boolean(safe.llm.apiKey) };
      delete safe.llm.apiKey;
    }

    res.status(200).json(safe);
  } catch (error) {
    req.app.get('logger').error(error, 'Fetching client config failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  getClientConfig
};
