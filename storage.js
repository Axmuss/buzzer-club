'use strict';
// Quiz storage. Uses MongoDB when MONGODB_URI is set (survives restarts on free hosts),
// otherwise a JSON file in ./data (fine on your own computer or a host with a persistent disk).
const fs = require('fs/promises');
const path = require('path');

const SEED_FILE = path.join(__dirname, 'data', 'seed-quizzes.json');
const DATA_FILE = process.env.QUIZ_FILE || path.join(__dirname, 'data', 'quizzes.json');

let impl = null;

async function readSeed() {
  return JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));
}

async function initMongo(seed) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const col = client.db(process.env.MONGODB_DB || 'buzzerclub').collection('quizzes');
  if ((await col.countDocuments()) === 0 && seed.length) {
    await col.insertMany(seed.map(({ id, ...rest }) => ({ _id: id, ...rest })));
  }
  const out = ({ _id, ...rest }) => ({ id: _id, ...rest });
  return {
    name: 'MongoDB',
    async list() { return (await col.find().toArray()).map(out); },
    async get(id) { const d = await col.findOne({ _id: id }); return d ? out(d) : null; },
    async save(quiz) { const { id, ...rest } = quiz; await col.replaceOne({ _id: id }, rest, { upsert: true }); },
    async remove(id) { await col.deleteOne({ _id: id }); },
  };
}

async function initFile(seed) {
  let quizzes;
  try {
    quizzes = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch {
    quizzes = seed;
  }
  let writing = Promise.resolve();
  const persist = () => {
    // Serialize writes and replace the file atomically so a crash never leaves half a file.
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(quizzes, null, 2));
      await fs.rename(tmp, DATA_FILE);
    });
    return writing;
  };
  await persist();
  return {
    name: 'file ' + DATA_FILE,
    async list() { return quizzes.slice(); },
    async get(id) { return quizzes.find(q => q.id === id) || null; },
    async save(quiz) {
      const i = quizzes.findIndex(q => q.id === quiz.id);
      if (i >= 0) quizzes[i] = quiz; else quizzes.push(quiz);
      await persist();
    },
    async remove(id) { quizzes = quizzes.filter(q => q.id !== id); await persist(); },
  };
}

module.exports = {
  async init() {
    const seed = await readSeed();
    impl = process.env.MONGODB_URI ? await initMongo(seed) : await initFile(seed);
    return impl.name;
  },
  list: () => impl.list(),
  get: id => impl.get(id),
  save: quiz => impl.save(quiz),
  remove: id => impl.remove(id),
};
