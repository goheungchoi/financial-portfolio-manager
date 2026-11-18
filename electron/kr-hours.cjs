// Korean days whose exchange hours differ from the usual ones, kept by hand until a calendar source carries hours
// (the KIS holiday calendar, kr_calendar, gives only open or closed). Read by market-hours.cjs (krOpen: the app's
// order window and every review that follows it), market-sessions.cjs (the sessions shown, offered and given to the
// model) and kis-client.cjs (the order-time guard), so all three agree.
//
// Each day: shift, the minutes the KRX regular session and its app window move; and sessions, the hours of each
// session that day ([start, end], plus the app's last order time for the regular session), or null when it is not
// held. A session not listed keeps its usual hours. source: the entry in docs/EXTERNAL-FACTS.md.
const SHIFTED_DAYS=Object.freeze({
  // College entrance exam (CSAT) day. KRX and Nextrade notices of 2026-11-05, as reported (F-KRX-CSAT-2026).
  '2026-11-19':Object.freeze({shift:60,source:'F-KRX-CSAT-2026',sessions:Object.freeze({
    'nxt-pre':null,
    'krx-pre':['09:30','09:40'],
    'krx-regular':['10:00','16:30','16:20'],
    'krx-post':['16:40','17:00'],
    'nxt-after':['16:40','20:00']})})});
// The usual KRX regular session and the app's order window, in minutes after Seoul midnight.
const OPEN=9*60,APP_END=15*60+20;
// The app's Korean order window on a Seoul day: {open, appEnd} in minutes after midnight.
function krWindow(day){const s=SHIFTED_DAYS[day]?.shift??0;return {open:OPEN+s,appEnd:APP_END+s};}
// A session's hours on a Seoul day: the usual row, the day's row ({start,end[,appEnd]}), or null when not held.
function sessionOn(day,row){const d=SHIFTED_DAYS[day];if(!d||!Object.hasOwn(d.sessions,row.id))return row;const h=d.sessions[row.id];if(h===null)return null;
  return {...row,start:h[0],end:h[1],...(h[2]?{appEnd:h[2]}:{}),shiftedBy:d.source};}
module.exports={SHIFTED_DAYS,krWindow,sessionOn};
