'use strict';
// Shorts on, stage 3 (the user's answer, 2026-11-25: "1. Stay on as saved"): a short-selling switch saved on before the
// paths could be sent stays on, and the update writes no setting. The first time the app sees it on for an account with
// no record here, one Home "Needs you" notice says what that now means, shown until dismissed, once per account, with one
// Activity line. Turning the switch on in this version goes through the new confirmation, so it is recorded as confirmed
// and no notice is shown. One row per account: state 'shown' (listed, not dismissed), 'dismissed' or 'confirmed'.
const STATES=['shown','dismissed','confirmed'];
class ShortsLiveNotice{
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS shorts_live_notice(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  state(account){try{const r=this.db.prepare('SELECT payload FROM shorts_live_notice WHERE account=?').get(String(account));const v=r?JSON.parse(r.payload):null;return STATES.includes(v?.state)?v.state:null;}catch{return null;}}
  note(account,state){if(!account||!STATES.includes(state))return;this.db.prepare('INSERT INTO shorts_live_notice VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(String(account),JSON.stringify({state,at:this.clock()}));}
  // Home's read (stage 4: no write): listed while recorded shown and the switch is on.
  listed(account,switchOn){return Boolean(account)&&switchOn===true&&this.state(account)==='shown';}
  // At a reading: whether the notice is listed, and whether this is its first (record it shown; the caller writes the
  // Activity line).
  // switchOn: the account's saved short.enabled.
  due(account,switchOn){if(!account||switchOn!==true)return {listed:false,first:false};const s=this.state(account);
    if(s==='dismissed'||s==='confirmed')return {listed:false,first:false};if(s===null){this.note(account,'shown');return {listed:true,first:true};}return {listed:true,first:false};}
}
// The conditional-order switches as words: the same sentence as src/short-confirm.mjs coverStopsWords (pinned equal).
function coverStopsWords(c){if(!c)return null;if(!c.armed)return 'Conditional orders are off now, so a short will have no stop and no loan-end buy-back until you turn them on in Engine settings.';
  if(c.whenHit==='not')return 'Conditional orders are on, but they are not watched now, so a stop or buy-back that is hit is neither sent nor proposed until you press Start (or keep them working while auto trading is stopped).';
  return c.whenHit==='sent'?'Conditional orders are on now, and a stop or buy-back that is hit is sent by itself.':'Conditional orders are on now, but a stop or buy-back that is hit is only proposed and waits for your approval.';}
// The words, from the saved values: auto (short.auto, with the short path's own automatic, true since shorts on) and
// coverStops ({armed, whenHit}, automation.coverStopsNow).
function noticeText({auto,coverStops}){coverStops=coverStopsWords(coverStops);
  const sent=auto===true?'A short the AI decides is sent by itself, within your cap.':'A short the AI decides is proposed and waits for your approval.';
  return {title:'Short selling can now be sent',
    detail:['Short selling was already on in Short & leverage, so since this update the app can send short sales and their buy-backs without a new confirmation.',sent,
      'No real short has been sent by this app yet, so the first one is also the first test with KIS.',...(coverStops?[coverStops]:[]),'To stop, turn short selling off in Short & leverage.'].join(' ')};}
const ACTIVITY_WORDS='Short selling was already on, so since this update the app can send short sales and buy-backs; the Home notice says what applies.';
module.exports={ShortsLiveNotice,noticeText,coverStopsWords,ACTIVITY_WORDS,STATES};
