const fs = require('fs');
const { ScanRun, ScanReport } = require('../models');
const { normalizeReportType } = require('../utils/reportStorage');

const CONTENT_TYPES = {
  founder: 'text/html; charset=utf-8',
  mindMap: 'text/html; charset=utf-8',
  impact: 'text/html; charset=utf-8',
  tickets: 'text/plain; charset=utf-8',
};

const getReportContent = async (req, res) => {
  try {
    const { scanId, reportType } = req.params;

    const reportKey = normalizeReportType(reportType);
    if (!reportKey) {
      return res.status(400).json({ error: 'Invalid report type requested.' });
    }

    const scanRun = await ScanRun.findOne({ scanId });
    if (!scanRun) {
      return res.status(404).json({ error: 'Scan run not found.' });
    }

    const scanReport = await ScanReport.findOne({ scanId });
    const cloudContent = scanReport?.reports?.[reportKey];
    if (cloudContent) {
      res.setHeader('Content-Type', CONTENT_TYPES[reportKey]);
      return res.status(200).send(cloudContent);
    }

    if (!scanRun.reportPathsLocal) {
      return res.status(404).json({ error: 'Report content not uploaded for this scan.' });
    }

    const localPathMap = {
      founder: scanRun.reportPathsLocal.founderReport,
      mindMap: scanRun.reportPathsLocal.mindMap,
      impact: scanRun.reportPathsLocal.byosyncImpact,
      tickets: scanRun.reportPathsLocal.developerTickets,
    };

    const targetPath = localPathMap[reportKey];
    if (!targetPath) {
      return res.status(404).json({ error: `Path for report type '${reportType}' is empty.` });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({
        error: 'Report file not found. The desktop client may not have uploaded report content yet.',
      });
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    res.setHeader('Content-Type', CONTENT_TYPES[reportKey]);
    return res.status(200).send(content);
  } catch (error) {
    req.app.get('logger').error(error, 'Retrieving report content failed');
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  getReportContent,
};
