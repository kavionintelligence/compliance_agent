const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const {
  Organization,
  User,
  Entitlement,
  DeviceSession
} = require('../models');

// Helper to extract email domain
const getEmailDomain = (email) => {
  const parts = email.split('@');
  return parts.length > 1 ? parts[1].toLowerCase() : '';
};

// Helper to check if domain is public email provider
const isPublicDomain = (domain) => {
  const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'zoho.com'];
  return publicDomains.includes(domain);
};

// Helper to hash token
const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Helper to generate access & refresh tokens
const generateTokens = (userId, organizationId, deviceId) => {
  const accessToken = jwt.sign(
    { userId, organizationId, deviceId },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const refreshToken = jwt.sign(
    { userId, organizationId, deviceId, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
};

// POST /api/v1/auth/register-device
const registerDevice = async (req, res) => {
  try {
    const {
      name,
      email,
      company,
      location,
      deviceId,
      appVersion,
      os,
      machineLabel
    } = req.body;

    if (!name || !email || !company || !deviceId) {
      return res.status(400).json({ error: 'Name, email, company, and deviceId are required fields.' });
    }

    const domain = getEmailDomain(email);
    const usePublic = isPublicDomain(domain);

    // Resolve Organization
    let org;
    if (!usePublic) {
      org = await Organization.findOne({ domain });
    }

    if (!org) {
      org = await Organization.create({
        name: `${company} Org`,
        domain: usePublic ? undefined : domain,
        plan: 'free',
        status: 'active',
        billingEmail: email,
        country: location || 'unknown'
      });

      // Initialize default entitlements
      await Entitlement.create({
        organizationId: org._id,
        plan: 'free',
        monthlyScanLimit: 10,
        monthlyTokenLimit: 50000,
        features: {
          llmReview: true,
          supportChat: true,
          autoUpdate: true,
          exportReports: false
        },
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        status: 'active'
      });
    }

    // Resolve User
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await User.create({
        organizationId: org._id,
        name,
        email: email.toLowerCase(),
        company,
        location,
        role: 'user',
        status: 'active',
        mfaEnabled: false
      });
    }

    // Handle Device Session
    let session = await DeviceSession.findOne({ deviceId });
    const { accessToken, refreshToken } = generateTokens(user._id, org._id, deviceId);
    const refreshTokenHash = hashToken(refreshToken);

    if (session) {
      session.userId = user._id;
      session.organizationId = org._id;
      session.appVersion = appVersion || session.appVersion;
      session.os = os || session.os;
      session.machineLabel = machineLabel || session.machineLabel;
      session.refreshTokenHash = refreshTokenHash;
      session.lastSeenAt = new Date();
      await session.save();
    } else {
      session = await DeviceSession.create({
        userId: user._id,
        organizationId: org._id,
        deviceId,
        appVersion,
        os,
        machineLabel,
        refreshTokenHash,
        lastSeenAt: new Date()
      });
    }

    res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      organization: {
        id: org._id,
        name: org.name,
        plan: org.plan
      }
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Device registration failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/auth/login (For Admin Console/Dashboard Portal)
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required fields.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash || user.status === 'suspended' || user.status === 'deleted') {
      return res.status(401).json({ error: 'Invalid email or password credentials.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password credentials.' });
    }

    // Generate tokens (Use 'admin-portal' or web-session as mock deviceId)
    const deviceId = `web-session-${crypto.randomBytes(8).toString('hex')}`;
    const { accessToken, refreshToken } = generateTokens(user._id, user.organizationId, deviceId);
    const refreshTokenHash = hashToken(refreshToken);

    // Save active web device session
    await DeviceSession.create({
      userId: user._id,
      organizationId: user.organizationId,
      deviceId,
      os: 'mac', // Mock platform
      appVersion: 'admin-portal',
      refreshTokenHash,
      lastSeenAt: new Date()
    });

    res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        mfaEnabled: user.mfaEnabled
      }
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Login failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/auth/refresh
const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    const session = await DeviceSession.findOne({ deviceId: decoded.deviceId });
    if (!session) {
      return res.status(401).json({ error: 'Session not found. Please log in again.' });
    }

    const currentTokenHash = hashToken(refreshToken);

    // Security check: Refresh Token Rotation Reuse Detection
    if (session.refreshTokenHash !== currentTokenHash) {
      // Replay attack detected! Revoke all sessions for the compromised user.
      await DeviceSession.deleteMany({ userId: session.userId });
      req.app.get('logger').warn(`🚨 Reuse detected for user ${session.userId}. Revoked all active sessions.`);
      return res.status(401).json({ error: 'Token reuse detected. All sessions revoked for safety.' });
    }

    // Generate new token pair
    const tokens = generateTokens(session.userId, session.organizationId, session.deviceId);
    session.refreshTokenHash = hashToken(tokens.refreshToken);
    session.lastSeenAt = new Date();
    await session.save();

    res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Token refresh failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/auth/logout
const logout = async (req, res) => {
  try {
    // When logged in via authenticateUser middleware
    if (req.deviceId) {
      await DeviceSession.deleteOne({ deviceId: req.deviceId });
      return res.status(200).json({ status: 'ok', message: 'Logged out successfully.' });
    }

    // fallback when auth token isn't fully validated (manual body input validation)
    const { deviceId } = req.body;
    if (deviceId) {
      await DeviceSession.deleteOne({ deviceId });
      return res.status(200).json({ status: 'ok', message: 'Logged out successfully.' });
    }

    res.status(400).json({ error: 'Missing device identifiers.' });
  } catch (error) {
    req.app.get('logger').error(error, 'Logout failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  registerDevice,
  login,
  refresh,
  logout
};
