const mongoose = require('mongoose');
const { Schema } = mongoose;

// 1. Organization Schema
const OrganizationSchema = new Schema({
  name: { type: String, required: true },
  domain: { type: String, sparse: true, unique: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  status: { type: String, enum: ['active', 'suspended', 'trial', 'deleted'], default: 'active' },
  billingEmail: { type: String },
  country: { type: String },
}, { timestamps: true });

OrganizationSchema.index({ status: 1, createdAt: -1 });

// 2. User Schema
const UserSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String }, // For admin portal / registered dashboard login
  company: { type: String },
  location: { type: String },
  role: { type: String, enum: ['user', 'admin', 'owner', 'support'], default: 'user' },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
  mfaSecret: { type: String }, // Encrypted TOTP secret for admins
  mfaEnabled: { type: Boolean, default: false },
  lastActiveAt: { type: Date },
  lastLoginAt: { type: Date },
}, { timestamps: true });

UserSchema.index({ organizationId: 1, status: 1 });
UserSchema.index({ role: 1, lastActiveAt: -1 });

// 3. Entitlement Schema
const EntitlementSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  monthlyScanLimit: { type: Number, default: 5 },
  monthlyTokenLimit: { type: Number, default: 50000 },
  features: {
    llmReview: { type: Boolean, default: false },
    supportChat: { type: Boolean, default: false },
    autoUpdate: { type: Boolean, default: false },
    exportReports: { type: Boolean, default: false },
  },
  currentPeriodStart: { type: Date },
  currentPeriodEnd: { type: Date },
  status: { type: String, enum: ['active', 'trial', 'past_due', 'suspended'], default: 'active' },
}, { timestamps: true });

// 4. DeviceSession Schema
const DeviceSessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  deviceId: { type: String, required: true, unique: true },
  appVersion: { type: String },
  os: { type: String, enum: ['windows', 'mac', 'linux'] },
  machineLabel: { type: String },
  refreshTokenHash: { type: String },
  pushSocketId: { type: String },
  lastSeenAt: { type: Date, default: Date.now },
  revokedAt: { type: Date },
  createdAt: { type: Date, default: Date.now, expires: 7776000 } // 90-day TTL Policy
});

DeviceSessionSchema.index({ userId: 1, lastSeenAt: -1 });

// 5. ScanRun Schema
const ScanRunSchema = new Schema({
  scanId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  deviceId: { type: String, required: true },
  appVersion: { type: String },
  targetType: { type: String, enum: ['repo', 'website', 'zip', 'unknown'], default: 'unknown' },
  targetFingerprint: { type: String },
  framework: { type: String, required: true },
  platform: { type: String },
  mode: { type: String },
  startedAt: { type: Date },
  completedAt: { type: Date },
  durationMs: { type: Number },
  scanHealth: { type: String, enum: ['ok', 'warning', 'failed'], default: 'ok' },
  findingCount: { type: Number, default: 0 },
  passCount: { type: Number, default: 0 },
  failCount: { type: Number, default: 0 },
  partialCount: { type: Number, default: 0 },
  unverifiedCount: { type: Number, default: 0 },
  humanAttestationCount: { type: Number, default: 0 },
  semanticReviewCount: { type: Number, default: 0 },
  coveragePercent: { type: Number, default: 0 },
  reportPathsLocal: {
    founderReport: { type: String },
    developerTickets: { type: String },
    byosyncImpact: { type: String },
    mindMap: { type: String },
  },
  reportsUploaded: { type: Boolean, default: false },
  errorSummary: { type: String },
  createdAt: { type: Date, default: Date.now }
});

ScanRunSchema.index({ userId: 1, startedAt: -1 });
ScanRunSchema.index({ organizationId: 1, startedAt: -1 });
ScanRunSchema.index({ framework: 1, startedAt: -1 });

// 6. LlmUsage Schema
const LlmUsageSchema = new Schema({
  scanId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  provider: { type: String, required: true },
  modelName: { type: String },
  promptTemplateVersion: { type: String },
  redactionMode: { type: String, enum: ['strict', 'balanced', 'off'], default: 'strict' },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  baseCostUsd: { type: Number, default: 0 },
  markedUpCostUsd: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

LlmUsageSchema.index({ scanId: 1 });
LlmUsageSchema.index({ organizationId: 1, createdAt: -1 });
LlmUsageSchema.index({ provider: 1, modelName: 1 });

// 7. RemoteConfig Schema
const RemoteConfigSchema = new Schema({
  environment: { type: String, enum: ['production', 'staging', 'dev'], required: true },
  version: { type: Number, required: true },
  active: { type: Boolean, default: false },
  llm: {
    enabled: { type: Boolean, default: true },
    provider: { type: String, default: 'company_proxy' },
    modelName: { type: String },
    apiKey: { type: String },
    redactionMode: { type: String, default: 'strict' },
    tokenBudgetPerScan: { type: Number, default: 100000 },
    markupPercent: { type: Number, default: 0 }
  },
  features: {
    supportChat: { type: Boolean, default: true },
    llmReview: { type: Boolean, default: true },
    autoUpdate: { type: Boolean, default: true },
    usageTelemetry: { type: Boolean, default: true },
    notifications: { type: Boolean, default: true }
  },
  api: {
    baseUrl: { type: String },
    socketUrl: { type: String },
    updateUrl: { type: String }
  },
  minSupportedAppVersion: { type: String },
  forceUpdateBelowVersion: { type: String },
  releaseChannel: { type: String, enum: ['stable', 'beta', 'internal'], default: 'stable' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

RemoteConfigSchema.index({ environment: 1, active: 1, version: -1 });

// 8. Notification Schema
const NotificationSchema = new Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  severity: { type: String, enum: ['info', 'success', 'warning', 'critical'], default: 'info' },
  targetType: { type: String, enum: ['all', 'organization', 'user', 'version', 'channel'], default: 'all' },
  targetValue: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
  deliveredCount: { type: Number, default: 0 },
  readCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Expiration TTL index
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
NotificationSchema.index({ targetType: 1, targetValue: 1 });

// 9. SupportTicket Schema
const SupportTicketSchema = new Schema({
  ticketId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  status: { type: String, enum: ['open', 'pending', 'resolved', 'closed'], default: 'open' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  subject: { type: String, required: true },
  lastMessageAt: { type: Date },
  assignedAdminId: { type: Schema.Types.ObjectId, ref: 'User' },
  relatedScanId: { type: String },
}, { timestamps: true });

SupportTicketSchema.index({ organizationId: 1, status: 1 });
SupportTicketSchema.index({ assignedAdminId: 1, status: 1 });

// 10. SupportMessage Schema
const SupportMessageSchema = new Schema({
  ticketId: { type: String, required: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  senderRole: { type: String, enum: ['user', 'admin', 'support'], required: true },
  message: { type: String, required: true },
  attachments: [{
    name: { type: String },
    type: { type: String },
    url: { type: String },
    redacted: { type: Boolean, default: false }
  }],
  readByUser: { type: Boolean, default: false },
  readByAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

SupportMessageSchema.index({ ticketId: 1, createdAt: 1 });

// 11. AdminAuditLog Schema
const AdminAuditLogSchema = new Schema({
  adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  targetType: { type: String, enum: ['user', 'organization', 'config', 'notification', 'release', 'support_ticket'], required: true },
  targetId: { type: String },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now }
});

AdminAuditLogSchema.index({ createdAt: -1 });
AdminAuditLogSchema.index({ adminId: 1, createdAt: -1 });

// 12. AppRelease Schema
const AppReleaseSchema = new Schema({
  version: { type: String, required: true },
  channel: { type: String, enum: ['stable', 'beta', 'internal'], default: 'stable' },
  platform: { type: String, enum: ['win32', 'darwin', 'linux'], required: true },
  releaseNotes: { type: String },
  downloadUrl: { type: String, required: true },
  signature: { type: String },
  sha512: { type: String },
  mandatory: { type: Boolean, default: false },
  minVersion: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  publishedAt: { type: Date }
}, { timestamps: true });

AppReleaseSchema.index({ platform: 1, channel: 1, version: -1 });

// 13. ScanReport Schema (cloud-stored report content for admin portal)
const ScanReportSchema = new Schema({
  scanId: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  reports: {
    founder: { type: String },
    mindMap: { type: String },
    impact: { type: String },
    tickets: { type: String },
  },
  uploadedAt: { type: Date, default: Date.now },
});

ScanReportSchema.index({ organizationId: 1, uploadedAt: -1 });

// Expose Mongoose compilation models
module.exports = {
  Organization: mongoose.model('Organization', OrganizationSchema),
  User: mongoose.model('User', UserSchema),
  Entitlement: mongoose.model('Entitlement', EntitlementSchema),
  DeviceSession: mongoose.model('DeviceSession', DeviceSessionSchema),
  ScanRun: mongoose.model('ScanRun', ScanRunSchema),
  LlmUsage: mongoose.model('LlmUsage', LlmUsageSchema),
  RemoteConfig: mongoose.model('RemoteConfig', RemoteConfigSchema),
  Notification: mongoose.model('Notification', NotificationSchema),
  SupportTicket: mongoose.model('SupportTicket', SupportTicketSchema),
  SupportMessage: mongoose.model('SupportMessage', SupportMessageSchema),
  AdminAuditLog: mongoose.model('AdminAuditLog', AdminAuditLogSchema),
  AppRelease: mongoose.model('AppRelease', AppReleaseSchema),
  ScanReport: mongoose.model('ScanReport', ScanReportSchema),
};
