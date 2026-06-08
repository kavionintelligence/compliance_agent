const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDatabase } = require('../config/mongo');
const {
  Organization,
  User,
  Entitlement,
  RemoteConfig
} = require('../models');

const seedDatabase = async () => {
  console.log('🌱 Starting database seeding script...');
  await connectDatabase();

  try {
    // 1. Seed Organization
    console.log('🏢 Seeding Organization...');
    let org = await Organization.findOne({ domain: 'byosync.com' });
    if (!org) {
      org = await Organization.create({
        name: 'ByoSync Global',
        domain: 'byosync.com',
        plan: 'enterprise',
        status: 'active',
        billingEmail: 'billing@byosync.com',
        country: 'IN'
      });
      console.log('✅ Created Organization: ByoSync Global');
    } else {
      console.log('ℹ️ Organization already exists, skipping.');
    }

    // 2. Seed Admin User
    console.log('👤 Seeding Admin User...');
    const adminEmail = 'admin@byosync.com';
    let admin = await User.findOne({ email: adminEmail });
    if (!admin) {
      const passwordHash = await bcrypt.hash('admin123', 10);
      admin = await User.create({
        organizationId: org._id,
        name: 'System Admin',
        email: adminEmail,
        passwordHash,
        role: 'admin',
        status: 'active',
        mfaEnabled: false
      });
      console.log('✅ Created Admin User: admin@byosync.com (Password: admin123)');
    } else {
      console.log('ℹ️ Admin user already exists, skipping.');
    }

    // 3. Seed Entitlements
    console.log('🎫 Seeding Entitlement...');
    let entitlement = await Entitlement.findOne({ organizationId: org._id });
    if (!entitlement) {
      entitlement = await Entitlement.create({
        organizationId: org._id,
        plan: 'enterprise',
        monthlyScanLimit: 1000,
        monthlyTokenLimit: 10000000,
        features: {
          llmReview: true,
          supportChat: true,
          autoUpdate: true,
          exportReports: true
        },
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        status: 'active'
      });
      console.log('✅ Created Entitlement for ByoSync Global');
    } else {
      console.log('ℹ️ Entitlement already exists, skipping.');
    }

    // 4. Seed Remote Configs for Dev, Staging, and Production
    console.log('⚙️ Seeding Remote Configs...');
    const environments = ['dev', 'staging', 'production'];

    for (const envName of environments) {
      let config = await RemoteConfig.findOne({ environment: envName, active: true });
      if (!config) {
        config = await RemoteConfig.create({
          environment: envName,
          version: 1,
          active: true,
          llm: {
            enabled: true,
            provider: 'company_proxy',
            modelName: 'gemini-2.5-flash',
            redactionMode: 'strict',
            tokenBudgetPerScan: 200000,
            markupPercent: 0
          },
          features: {
            supportChat: true,
            llmReview: true,
            autoUpdate: true,
            usageTelemetry: true,
            notifications: true
          },
          api: {
            baseUrl: envName === 'production' ? 'https://api.byosync.com' : `https://api-${envName}.byosync.com`,
            socketUrl: envName === 'production' ? 'wss://api.byosync.com' : `wss://api-${envName}.byosync.com`,
            updateUrl: envName === 'production' ? 'https://api.byosync.com/api/v1/releases/check' : `https://api-${envName}.byosync.com/api/v1/releases/check`
          },
          minSupportedAppVersion: '1.0.0',
          forceUpdateBelowVersion: '0.9.0',
          releaseChannel: 'stable',
          updatedBy: admin._id
        });
        console.log(`✅ Created active RemoteConfig for [${envName}]`);
      } else {
        console.log(`ℹ️ Active RemoteConfig for [${envName}] already exists, skipping.`);
      }
    }

    console.log('🎉 Database seeding complete!');
  } catch (error) {
    console.error('❌ Seeding failed with error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Disconnected from database.');
  }
};

if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
