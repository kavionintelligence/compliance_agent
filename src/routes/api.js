const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Middlewares
const { authenticateUser, requireRole } = require('../middleware/auth');

// Controllers
const authController = require('../controllers/authController');
const configController = require('../controllers/configController');
const scanController = require('../controllers/scanController');
const llmController = require('../controllers/llmController');
const adminController = require('../controllers/adminController');
const reportsController = require('../controllers/reportsController');
const recheckController = require('../controllers/recheckController');

const { AppRelease } = require('../models');

// ── Rate Limiter Factories ────────────────────────────────────────────────────
//
// IMPORTANT: For authenticated routes we key by USER ID (req.user._id), NOT by
// IP address. This means:
//   • 100 concurrent users each get their own independent bucket.
//   • A shared corporate NAT or Vercel proxy IP never merges user quotas.
//   • One busy user cannot cause "429 Too many requests" for another.
//
// For unauthenticated endpoints (login / register) we keep IP-based limiting
// because there is no user ID available yet, and brute-force protection is the goal.

/**
 * IP-based limiter — only for unauthenticated endpoints.
 * Relies on trust-proxy being configured in server.js so Vercel's
 * x-forwarded-for header is used instead of the proxy IP.
 */
function makeIpLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    // Default keyGenerator uses req.ip which works correctly once trust proxy is set
  });
}

/**
 * User-ID-based limiter — for all authenticated routes.
 * authenticateUser middleware must run BEFORE this limiter so req.user is set.
 * Falls back to IP if somehow req.user is missing (should never happen in practice).
 */
function makeUserLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    keyGenerator: (req) => {
      // Use MongoDB user _id as key so 100 users = 100 independent buckets
      const userId = req.user?._id?.toString();
      return userId || req.ip; // fallback to IP if user not resolved yet
    },
  });
}

// ── Per-route limiters ────────────────────────────────────────────────────────

// Auth: IP-based, strict — prevents brute-force on registration/login
const authLimiter = makeIpLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per IP per 15min
  message: 'Too many login attempts. Please try again after 15 minutes.',
});

// Telemetry: user-based — each user can fire up to 30 scan events/min
// (a single scan fires start + complete = 2 events; this leaves plenty of headroom)
const telemetryLimiter = makeUserLimiter({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,
  message: 'Telemetry rate limit reached. Scan data will be queued and retried.',
});

// Support chat: user-based — frontend polls every 30s (2 req/min); allow 10x headroom
// for bursts when the user is actively typing
const supportLimiter = makeUserLimiter({
  windowMs: 60 * 1000,  // 1 minute
  max: 20,
  message: 'Support message rate limit reached. Please wait a moment.',
});

// Admin panel: user-based — admin browses pages, no need to be aggressive
const adminLimiter = makeUserLimiter({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,
  message: 'Admin request rate limit reached. Please slow down.',
});

// LLM proxy: user-based — expensive calls, keep per-user tight
const llmLimiter = makeUserLimiter({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,
  message: 'LLM request rate limit reached. Please wait before retrying.',
});

// ── Auth Endpoints (IP-based, unauthenticated) ────────────────────────────────
router.post('/auth/register-device', authLimiter, authController.registerDevice);
router.post('/auth/login',           authLimiter, authController.login);
router.post('/auth/refresh',         authLimiter, authController.refresh);
router.post('/auth/logout',                       authController.logout);

// ── Config Endpoints (no auth, no sensitive data) ─────────────────────────────
router.get('/config/client', configController.getClientConfig);

// ── Scan Telemetry Endpoints (user-based limiter) ─────────────────────────────
router.post('/scans/start',           authenticateUser, telemetryLimiter, scanController.startScan);
router.post('/scans/complete',        authenticateUser, telemetryLimiter, scanController.completeScan);
router.post('/scans/error',           authenticateUser, telemetryLimiter, scanController.logScanError);
router.post('/scans/recheck/complete',authenticateUser, telemetryLimiter, recheckController.completeRecheck);

// ── User Support Chat (user-based limiter) ────────────────────────────────────
router.get('/support/messages',  authenticateUser, supportLimiter, adminController.getUserSupportMessages);
router.post('/support/messages', authenticateUser, supportLimiter, adminController.createUserSupportMessage);

// ── LLM Proxy (user-based limiter) ───────────────────────────────────────────
router.post('/llm/review',         authenticateUser, llmLimiter, llmController.handleLlmReview);
router.post('/llm/generate-probe', authenticateUser, llmLimiter, llmController.handleGenerateProbe);

// ── App Update Check (no auth, low traffic) ───────────────────────────────────
router.get('/releases/check', async (req, res) => {
  try {
    const { version, platform, channel } = req.query;
    if (!platform) {
      return res.status(400).json({ error: 'platform query parameter is required.' });
    }

    const targetChannel = channel || 'stable';

    const latestRelease = await AppRelease.findOne({
      platform,
      channel: targetChannel
    }).sort({ createdAt: -1 });

    if (!latestRelease) {
      return res.status(200).json({ update_available: false, reason: 'No release found for the target platform.' });
    }

    const hasUpdate = latestRelease.version !== version;

    res.status(200).json({
      update_available: hasUpdate,
      latest_version: latestRelease.version,
      download_url: latestRelease.downloadUrl,
      signature: latestRelease.signature,
      sha512: latestRelease.sha512,
      mandatory: latestRelease.mandatory,
      release_notes: latestRelease.releaseNotes
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error occurred checking releases.' });
  }
});

// ── Admin Operations (user-based limiter, admin role required) ────────────────
router.get('/admin/users',                       authenticateUser, requireRole(['admin']), adminLimiter, adminController.getUsers);
router.get('/admin/organizations',               authenticateUser, requireRole(['admin']), adminLimiter, adminController.getOrganizations);
router.get('/admin/scans/summary',               authenticateUser, requireRole(['admin']), adminLimiter, adminController.getScansSummary);
router.get('/admin/usage/tokens',                authenticateUser, requireRole(['admin']), adminLimiter, adminController.getTokensUsage);
router.post('/admin/config',                     authenticateUser, requireRole(['admin']), adminLimiter, adminController.updateRemoteConfig);
router.post('/admin/notifications',              authenticateUser, requireRole(['admin']), adminLimiter, adminController.createNotification);
router.post('/admin/releases',                   authenticateUser, requireRole(['admin']), adminLimiter, adminController.publishRelease);
router.get('/admin/audit-logs',                  authenticateUser, requireRole(['admin']), adminLimiter, adminController.getAuditLogs);
router.get('/admin/scans',                       authenticateUser, requireRole(['admin']), adminLimiter, adminController.getScansList);
router.get('/admin/projects',                    authenticateUser, requireRole(['admin']), adminLimiter, adminController.getProjects);
router.get('/admin/projects/:projectId',         authenticateUser, requireRole(['admin']), adminLimiter, adminController.getProjectDetail);
router.get('/admin/recheck-jobs',                authenticateUser, requireRole(['admin']), adminLimiter, adminController.getRecheckJobs);
router.get('/admin/finding-changes',             authenticateUser, requireRole(['admin']), adminLimiter, adminController.getFindingChanges);
router.get('/admin/scans/:scanId/report/:reportType', authenticateUser, requireRole(['admin']), adminLimiter, reportsController.getReportContent);
router.get('/admin/support/tickets',             authenticateUser, requireRole(['admin']), adminLimiter, adminController.getSupportTickets);
router.get('/admin/support/tickets/:ticketId/messages',  authenticateUser, requireRole(['admin']), adminLimiter, adminController.getTicketMessages);
router.post('/admin/support/tickets/:ticketId/messages', authenticateUser, requireRole(['admin', 'support']), adminLimiter, adminController.createAdminSupportMessage);

module.exports = router;
