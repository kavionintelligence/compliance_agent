const express = require('express');
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

const { AppRelease } = require('../models');

// ── Auth Endpoints ───────────────────────────────────────────────────────────
router.post('/auth/register-device', authController.registerDevice);
router.post('/auth/login', authController.login);
router.post('/auth/refresh', authController.refresh);
router.post('/auth/logout', authController.logout);

// ── Config Endpoints ──────────────────────────────────────────────────────────
router.get('/config/client', configController.getClientConfig);

// ── Scan Telemetry Endpoints (Secure) ─────────────────────────────────────────
router.post('/scans/start', authenticateUser, scanController.startScan);
router.post('/scans/complete', authenticateUser, scanController.completeScan);
router.post('/scans/error', authenticateUser, scanController.logScanError);

// ── LLM Proxy Endpoints (Secure) ──────────────────────────────────────────────
router.post('/llm/review', authenticateUser, llmController.handleLlmReview);
router.post('/llm/generate-probe', authenticateUser, llmController.handleGenerateProbe);

// ── App Update Check Endpoint ────────────────────────────────────────────────
// GET /api/v1/releases/check?version=X&platform=Y&channel=Z
router.get('/releases/check', async (req, res) => {
  try {
    const { version, platform, channel } = req.query;
    if (!platform) {
      return res.status(400).json({ error: 'platform query parameter is required.' });
    }

    const targetChannel = channel || 'stable';

    // Find the latest release package matching platform and channel
    const latestRelease = await AppRelease.findOne({
      platform,
      channel: targetChannel
    }).sort({ createdAt: -1 });

    if (!latestRelease) {
      return res.status(200).json({ update_available: false, reason: 'No release found for the target platform.' });
    }

    // Basic semver check stub
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

// ── Admin Operations (Secure: Admins Only) ───────────────────────────────────
router.get('/admin/users', authenticateUser, requireRole(['admin']), adminController.getUsers);
router.get('/admin/organizations', authenticateUser, requireRole(['admin']), adminController.getOrganizations);
router.get('/admin/scans/summary', authenticateUser, requireRole(['admin']), adminController.getScansSummary);
router.get('/admin/usage/tokens', authenticateUser, requireRole(['admin']), adminController.getTokensUsage);
router.post('/admin/config', authenticateUser, requireRole(['admin']), adminController.updateRemoteConfig);
router.post('/admin/notifications', authenticateUser, requireRole(['admin']), adminController.createNotification);
router.post('/admin/releases', authenticateUser, requireRole(['admin']), adminController.publishRelease);
router.get('/admin/audit-logs', authenticateUser, requireRole(['admin']), adminController.getAuditLogs);
router.get('/admin/scans', authenticateUser, requireRole(['admin']), adminController.getScansList);
router.get('/admin/scans/:scanId/report/:reportType', authenticateUser, requireRole(['admin']), reportsController.getReportContent);
router.get('/admin/support/tickets', authenticateUser, requireRole(['admin']), adminController.getSupportTickets);
router.get('/admin/support/tickets/:ticketId/messages', authenticateUser, requireRole(['admin']), adminController.getTicketMessages);

module.exports = router;
