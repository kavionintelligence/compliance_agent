const fs = require('fs');
const path = require('path');
const { ScanRun } = require('../models');

const getReportContent = async (req, res) => {
  try {
    const { scanId, reportType } = req.params;

    const scanRun = await ScanRun.findOne({ scanId });
    if (!scanRun) {
      return res.status(404).json({ error: 'Scan run not found.' });
    }

    if (!scanRun.reportPathsLocal) {
      return res.status(404).json({ error: 'Report paths not recorded for this scan.' });
    }

    let targetPath = '';
    let contentType = 'text/html; charset=utf-8';

    switch (reportType.toLowerCase()) {
      case 'founder':
      case 'founderreport':
        targetPath = scanRun.reportPathsLocal.founderReport;
        break;
      case 'mindmap':
      case 'mindmap':
        targetPath = scanRun.reportPathsLocal.mindMap;
        break;
      case 'impact':
      case 'byosyncimpact':
        targetPath = scanRun.reportPathsLocal.byosyncImpact;
        break;
      case 'tickets':
      case 'developertickets':
        targetPath = scanRun.reportPathsLocal.developerTickets;
        contentType = 'text/plain; charset=utf-8';
        break;
      default:
        return res.status(400).json({ error: 'Invalid report type requested.' });
    }

    if (!targetPath) {
      return res.status(404).json({ error: `Path for report type '${reportType}' is empty.` });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: `Report file not found on server disk at: ${targetPath}` });
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(content);
  } catch (error) {
    req.app.get('logger').error(error, 'Retrieving report content failed');
    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

module.exports = {
  getReportContent
};
