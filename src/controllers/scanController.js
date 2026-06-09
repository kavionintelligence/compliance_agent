const { ScanRun, ScanReport, Entitlement } = require('../models');
const { sanitizeReportsPayload } = require('../utils/reportStorage');

// POST /api/v1/scans/start
const startScan = async (req, res) => {
  try {
    const {
      scanId,
      targetType,
      targetFingerprint,
      framework,
      platform,
      mode
    } = req.body;

    if (!scanId || !framework) {
      return res.status(400).json({ error: 'scanId and framework are required fields.' });
    }

    // Check Entitlement scan limits before starting
    const entitlement = await Entitlement.findOne({ organizationId: req.org._id });
    if (entitlement && entitlement.status !== 'suspended') {
      const activeScansCount = await ScanRun.countDocuments({
        organizationId: req.org._id,
        createdAt: { $gte: entitlement.currentPeriodStart, $lte: entitlement.currentPeriodEnd }
      });

      if (activeScansCount >= entitlement.monthlyScanLimit) {
        return res.status(403).json({
          error: 'Scan limit exceeded. Please upgrade your ByoSync subscription plan.',
          code: 'LIMIT_EXCEEDED'
        });
      }
    }

    const scanRun = await ScanRun.create({
      scanId,
      userId: req.user._id,
      organizationId: req.org._id,
      deviceId: req.deviceId,
      appVersion: req.headers['x-app-version'] || 'unknown',
      targetType,
      targetFingerprint,
      framework,
      platform,
      mode,
      startedAt: new Date(),
      scanHealth: 'ok'
    });

    res.status(201).json({
      status: 'started',
      scanId: scanRun.scanId
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Starting scan log failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/scans/complete
const completeScan = async (req, res) => {
  try {
    const { scanId } = req.body;
    if (!scanId) {
      return res.status(400).json({ error: 'scanId is a required field.' });
    }

    const scanRun = await ScanRun.findOne({ scanId, organizationId: req.org._id });
    if (!scanRun) {
      return res.status(404).json({ error: 'Active scan run session not found.' });
    }

    const {
      durationMs,
      scanHealth,
      findingCount,
      passCount,
      failCount,
      partialCount,
      unverifiedCount,
      humanAttestationCount,
      semanticReviewCount,
      coveragePercent,
      reportPathsLocal,
      reports,
      runtimeProbeCount,
      runtimePassCount,
      runtimeGapCount,
      runtimeInconclusiveCount,
      runtimeBlockedCount,
      executedProbes
    } = req.body;

    scanRun.completedAt = new Date();
    scanRun.durationMs = durationMs || (Date.now() - scanRun.startedAt.getTime());
    scanRun.scanHealth = scanHealth || 'ok';
    scanRun.findingCount = findingCount || 0;
    scanRun.passCount = passCount || 0;
    scanRun.failCount = failCount || 0;
    scanRun.partialCount = partialCount || 0;
    scanRun.unverifiedCount = unverifiedCount || 0;
    scanRun.humanAttestationCount = humanAttestationCount || 0;
    scanRun.semanticReviewCount = semanticReviewCount || 0;
    scanRun.coveragePercent = coveragePercent || 0;
    scanRun.reportPathsLocal = reportPathsLocal || scanRun.reportPathsLocal;

    // Record DVL telemetry
    scanRun.runtimeProbeCount = runtimeProbeCount || 0;
    scanRun.runtimePassCount = runtimePassCount || 0;
    scanRun.runtimeGapCount = runtimeGapCount || 0;
    scanRun.runtimeInconclusiveCount = runtimeInconclusiveCount || 0;
    scanRun.runtimeBlockedCount = runtimeBlockedCount || 0;
    scanRun.executedProbes = executedProbes || [];

    const sanitizedReports = sanitizeReportsPayload(reports);
    if (sanitizedReports) {
      await ScanReport.findOneAndUpdate(
        { scanId },
        {
          scanId,
          organizationId: req.org._id,
          reports: sanitizedReports,
          uploadedAt: new Date(),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      scanRun.reportsUploaded = true;
    }

    await scanRun.save();

    res.status(200).json({
      status: 'completed',
      scanId: scanRun.scanId,
      reportsUploaded: Boolean(sanitizedReports),
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Completing scan log failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

// POST /api/v1/scans/error
const logScanError = async (req, res) => {
  try {
    const { scanId, errorSummary } = req.body;
    if (!scanId || !errorSummary) {
      return res.status(400).json({ error: 'scanId and errorSummary are required fields.' });
    }

    const scanRun = await ScanRun.findOne({ scanId, organizationId: req.org._id });
    if (!scanRun) {
      // Create stub error log if starts fail entirely
      await ScanRun.create({
        scanId,
        userId: req.user._id,
        organizationId: req.org._id,
        deviceId: req.deviceId,
        appVersion: req.headers['x-app-version'] || 'unknown',
        scanHealth: 'failed',
        errorSummary,
        startedAt: new Date(),
        completedAt: new Date()
      });
    } else {
      scanRun.scanHealth = 'failed';
      scanRun.errorSummary = errorSummary;
      scanRun.completedAt = new Date();
      await scanRun.save();
    }

    res.status(200).json({ status: 'logged', scanId });
  } catch (error) {
    req.app.get('logger').error(error, 'Logging scan error failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  startScan,
  completeScan,
  logScanError
};
