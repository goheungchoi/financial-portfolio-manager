// Preload for tests/run-hours.cjs: Date starts at PORTFOLIO_FAKE_NOW (an ISO time) and keeps running from there, so a
// test file runs as if at that hour. Nothing else (timers, performance) is touched. Without the variable it does nothing.
const target=Date.parse(process.env.PORTFOLIO_FAKE_NOW??'');
if(Number.isFinite(target)){const RealDate=Date;const delta=target-RealDate.now();
  class ShiftedDate extends RealDate{constructor(...args){super(...(args.length?args:[RealDate.now()+delta]));}static now(){return RealDate.now()+delta;}}
  globalThis.Date=ShiftedDate;}
