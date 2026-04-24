import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
const col = mongoose.connection.db.collection('learningitems');

const r1 = await col.updateMany({ introSeen: true },  { $set: { status: 'review' } });
const r2 = await col.updateMany({ introSeen: false }, { $set: { status: 'new' } });

console.log('review:', r1.modifiedCount, '| new:', r2.modifiedCount);
await mongoose.disconnect();