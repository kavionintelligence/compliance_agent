const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const REPORT_FIELD_MAP = {
  founder: 'founder',
  founderreport: 'founder',
  mindmap: 'mindMap',
  impact: 'impact',
  byosyncimpact: 'impact',
  tickets: 'tickets',
  developertickets: 'tickets',
};

const normalizeReportType = (reportType) => {
  if (!reportType) return null;
  return REPORT_FIELD_MAP[reportType.toLowerCase()] || null;
};

const sanitizeReportsPayload = (reports) => {
  if (!reports || typeof reports !== 'object') return null;

  const sanitized = {};
  for (const [rawKey, content] of Object.entries(reports)) {
    const key = REPORT_FIELD_MAP[rawKey.toLowerCase()];
    if (!key || typeof content !== 'string' || !content.trim()) continue;
    if (Buffer.byteLength(content, 'utf8') > MAX_REPORT_BYTES) continue;
    sanitized[key] = content;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
};

module.exports = {
  MAX_REPORT_BYTES,
  REPORT_FIELD_MAP,
  normalizeReportType,
  sanitizeReportsPayload,
};
