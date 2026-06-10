const {
  Project,
  ScanRevision,
  EvidenceSubmission,
  TargetedRecheckJob,
  FindingChangeLog,
  ScanRun,
} = require('../models');

// POST /api/v1/scans/recheck/complete
const completeRecheck = async (req, res) => {
  try {
    const {
      baseScanId,
      scanId,
      projectName,
      targetFingerprint,
      controlId,
      findingId,
      sessionId,
      previousStatus,
      newStatus,
      verificationMethod,
      localScanDir,
      evidence = [],
      mindMapPath = [],
      revisionNumber,
      reportVersion,
    } = req.body;

    if (!baseScanId || !controlId) {
      return res.status(400).json({ error: 'baseScanId and controlId are required.' });
    }

    let project = null;
    if (projectName) {
      project = await Project.findOneAndUpdate(
        { organizationId: req.org._id, name: projectName },
        {
          organizationId: req.org._id,
          name: projectName,
          targetFingerprint: targetFingerprint || undefined,
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const jobId = sessionId || `recheck_${Date.now()}`;
    const recheckJob = await TargetedRecheckJob.create({
      jobId,
      organizationId: req.org._id,
      projectId: project?._id,
      baseScanId,
      controlId,
      findingId,
      status: 'complete',
      verificationMethod,
      previousStatus,
      newStatus,
      localScanDir,
      sessionId,
      createdBy: req.user._id,
    });

    if (Array.isArray(evidence)) {
      for (const item of evidence) {
        if (!item?.source) continue;
        await EvidenceSubmission.create({
          organizationId: req.org._id,
          projectId: project?._id,
          scanId: scanId || baseScanId,
          recheckJobId: recheckJob._id,
          evidenceType: item.type || 'unknown',
          source: item.source,
          sha256: item.sha256,
          trustLevel: item.trust_level || item.trustLevel,
          submittedBy: req.user._id,
        });
      }
    }

    await FindingChangeLog.create({
      organizationId: req.org._id,
      projectId: project?._id,
      scanId: scanId || baseScanId,
      recheckJobId: recheckJob._id,
      controlId,
      findingId,
      previousStatus,
      newStatus,
      verificationMethod,
      evidenceTypes: Array.isArray(evidence) ? evidence.map((e) => e.type).filter(Boolean) : [],
      mindMapPath: Array.isArray(mindMapPath) ? mindMapPath : [],
    });

    await ScanRevision.create({
      projectId: project?._id,
      organizationId: req.org._id,
      scanId: scanId || baseScanId,
      baseScanId,
      revisionType: 'targeted_fix',
      revisionNumber: revisionNumber || 1,
      reportVersion: reportVersion || undefined,
      localScanDir,
      changedControls: [controlId],
    });

    if (scanId) {
      const scanRun = await ScanRun.findOne({ scanId, organizationId: req.org._id });
      if (scanRun && project) {
        scanRun.projectId = project._id;
        await scanRun.save();
      }
    }

    res.status(200).json({
      status: 'recorded',
      jobId: recheckJob.jobId,
      projectId: project?._id,
    });
  } catch (error) {
    req.app.get('logger').error(error, 'Recording targeted recheck failed');
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  completeRecheck,
};
