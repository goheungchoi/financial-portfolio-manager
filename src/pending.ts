import type {PortfolioState} from './UnifiedPortfolio';
// U.S. sale proceeds KIS has not settled yet, in KRW at the portfolio's rate: part of equity, not cash. Screens that add
// holdings and cash themselves add this too (Home once showed the total without a U.S. sale's unsettled proceeds).
export function pendingKRW(state:Pick<PortfolioState,'pendingSettlement'|'fx'>):number{return (state.pendingSettlement?.USD??0)*(state.fx?.usdKRW??0);}
