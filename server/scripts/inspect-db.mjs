import mongoose from 'mongoose';

async function run() {
  const admin = await mongoose.createConnection('mongodb://127.0.0.1:27017/admin').asPromise();
  const dbs = (await new mongoose.mongo.Admin(admin.db).listDatabases()).databases.map(d => d.name);
  for (const dbName of dbs) {
    const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/' + dbName).asPromise();
    for (const colName of ['emergencies', 'voicereports']) {
      try {
        const docs = await conn.collection(colName).find({
          $or: [
            { 'location.address': /college/i },
            { address: /college/i },
            { transcript: /college/i },
            { description: /college/i },
            { 'extractedData.location': /college/i },
            { _id: 'EMG-20485' },
          ]
        }).toArray();
        if (docs.length > 0) {
          console.log(`=== Found in ${dbName}.${colName} (${docs.length}) ===`);
          console.log(JSON.stringify(docs, null, 2));
        }
      } catch (e) {}
    }
    await conn.close();
  }
  await admin.close();
}

run().catch(console.error);
