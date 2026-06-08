const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Organization } = require('../models');

// Helper to authenticate client/admin JWT
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. Authorization token missing or malformed.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);

    // Resolve user and organization
    const user = await User.findById(decoded.userId);
    if (!user || user.status === 'suspended' || user.status === 'deleted') {
      return res.status(403).json({ error: 'User account is inactive or suspended.' });
    }

    const org = await Organization.findById(user.organizationId);
    if (!org || org.status === 'suspended' || org.status === 'deleted') {
      return res.status(403).json({ error: 'Organization account is inactive or suspended.' });
    }

    // Attach to request
    req.user = user;
    req.org = org;
    req.deviceId = decoded.deviceId;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }
};

// Require specific roles (e.g. admin, support)
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access forbidden. Insufficient permissions.' });
    }
    next();
  };
};

module.exports = {
  authenticateUser,
  requireRole,
};
