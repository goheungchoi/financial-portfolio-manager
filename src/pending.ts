import type {PortfolioState} from './UnifiedPortfolio';
// U.S. sale proceeds KIS has not settled yet, in KRW at the portfolio's rate: part of equity, not cash. Screens that add
// holdings and cash themselves add this too (2026-10-30: Home still showed the total without the GOOGL proceeds).
export function pendingKRW(state:Pick<PortfolioState,'pendingSettlement'|'fx'>):number{return (state.pendingSettlement?.USD??0)*(state.fx?.usdKRW??0);}
