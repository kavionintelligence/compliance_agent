const mongoose = require('mongoose');
const env = require('./env');

const connectDatabase = async () => {
  try {
    // Enable strictQuery for schema enforcement
    mongoose.set('strictQuery', true);

    mongoose.connection.on('connecting', () => {
      console.log('🔄 Connecting to MongoDB database...');
    });

    mongoose.connection.on('connected', () => {
      console.log('✅ MongoDB connection established successfully.');
    });

    mongoose.connection.on('disconnected', () => {
      console.log('⚠️ MongoDB connection lost. Attempting to reconnect...');
    });

    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB Connection Error:', err);
    });

    await mongoose.connect(env.MONGO_URI);
  } catch (error) {
    console.error('❌ Failed to establish initial connection to MongoDB:', error);
    if (!process.env.VERCEL) {
      process.exit(1);
    }
    throw error;
  }
};

module.exports = {
  connectDatabase,
  connection: mongoose.connection,
};
