/**
 * 各数据源的默认地址（配置层与 provider 层共用，避免两处硬编码漂移）。
 */

/** Digital Extremes 官方 WorldState（默认、首选数据源） */
export const DEFAULT_WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';

/** WarframeStat.us 裂缝接口（备用数据源，固定 en locale） */
export const DEFAULT_WARFRAMESTAT_API_URL = 'https://api.warframestat.us/pc/fissures?language=en';
