'use strict';
// Privacy clean-up (2026-11-19): the procedural lesson's support line no longer names the owner's trade. Its signature
// hashes the lesson text only, so rewording the support line changes no stored signature or approval; and the draft is
// proposed once, so a lesson already stored keeps its own record.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {createHash}=require('node:crypto');
const {LearningMemory,PROCEDURAL}=require('../electron/learning-memory.cjs');
test('the procedural lesson\'s signature is the hash of its text alone; the support line is a general sentence',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT)');const m=new LearningMemory(db);m.proposeProcedural();
  const row=db.prepare('SELECT signature,payload FROM lesson_evidence WHERE id=?').get(PROCEDURAL.id);
  assert.equal(row.signature,createHash('sha256').update(PROCEDURAL.text).digest('hex'),'text only');
  assert.equal(JSON.parse(row.payload).support,PROCEDURAL.support);
  assert.equal(PROCEDURAL.support,'Low-confidence empirical support: one sale and re-entry of the same holding. A procedural reminder, not a validated trading rule.');
  // A lesson already stored (with its approval) is never proposed again: the stored record and signature stay.
  m.saveLifecycle(PROCEDURAL.id,{status:'approved',approvedAt:1});db.prepare('UPDATE lesson_evidence SET payload=? WHERE id=?').run(JSON.stringify({support:'an older support line'}),PROCEDURAL.id);
  m.proposeProcedural();assert.equal(m.lifecycle(PROCEDURAL.id).status,'approved');
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM lesson_evidence WHERE id=?').get(PROCEDURAL.id).payload).support,'an older support line');
});
