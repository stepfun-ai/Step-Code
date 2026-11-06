/**
 * Mid-pane views opened from the sidebar: scheduled tasks and the extension
 * market. Both cover the conversation until closed. Tasks use demo data;
 * the market owns the read-only catalog, detail pages and local add controls.
 */

import "./market.css";
import "./extension-market.css";
import "./extension-detail.css";

export { CronView, closeMidView, MarketView, openMidView } from "./MidViews";
