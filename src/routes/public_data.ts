import { Hono } from 'hono';
import {
  fetchWeatherForecast,
  fetchWeatherWarnings,
  fetchRecentEarthquakes,
  fetchRoadTraffic,
  searchLaws,
  getLawData,
  searchDietMinutes,
  fetchElevationAndCoordinates,
  fetchFlightStatus,
} from '../scraper.js';
import {
  DisasterWarningsRequestSchema,
  EarthquakeRequestSchema,
  RoadTrafficRequestSchema,
  LawSearchRequestSchema,
  LawDataRequestSchema,
  DietMinutesSearchRequestSchema,
  ElevationRequestSchema,
  FlightStatusRequestSchema,
} from '../types.js';
import { formatError } from './utils.js';

export const publicDataRoutes = new Hono();

// 天気予報 (POST /weather)
publicDataRoutes.post('/weather', async (c) => {
  try {
    const body = await c.req.json();
    const city = body?.city;
    if (!city || typeof city !== 'string') {
      return c.json({ error: 'city is required' }, 400);
    }

    const days = body?.days ? parseInt(body.days, 10) : undefined;
    const result = await fetchWeatherForecast({ city, days, noCache: body?.noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

// 天気予報 (GET /weather & GET /weather/:city)
publicDataRoutes.get('/weather/:city', async (c) => {
  try {
    const city = c.req.param('city');
    const daysParam = c.req.query('days');
    const days = daysParam ? parseInt(daysParam, 10) : undefined;
    const noCache = c.req.query('noCache') === 'true';

    const result = await fetchWeatherForecast({ city, days, noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

publicDataRoutes.get('/weather', async (c) => {
  try {
    const city = c.req.query('city') || '東京';
    const daysParam = c.req.query('days');
    const days = daysParam ? parseInt(daysParam, 10) : undefined;
    const noCache = c.req.query('noCache') === 'true';

    const result = await fetchWeatherForecast({ city, days, noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

// 気象警報・注意報 (POST /disaster/warnings)
publicDataRoutes.post('/disaster/warnings', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = DisasterWarningsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid disaster warnings parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchWeatherWarnings(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Disaster warnings fetch failed', 'DISASTER_ERROR', 500);
  }
});

// 地震速報・履歴 (POST /disaster/earthquake)
publicDataRoutes.post('/disaster/earthquake', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = EarthquakeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid earthquake parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchRecentEarthquakes(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Earthquake search failed', 'EARTHQUAKE_ERROR', 500);
  }
});

// 道路交通情報 (POST /traffic/road)
publicDataRoutes.post('/traffic/road', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = RoadTrafficRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid road traffic parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchRoadTraffic(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

// 道路交通情報 GET (GET /traffic/road & GET /traffic/road/:pref)
publicDataRoutes.get('/traffic/road', async (c) => {
  const pref = c.req.query('pref');
  const road = c.req.query('road');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchRoadTraffic({ pref, road, noCache });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

publicDataRoutes.get('/traffic/road/:pref', async (c) => {
  const pref = c.req.param('pref');
  const road = c.req.query('road');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchRoadTraffic({ pref, road, noCache });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

// e-Gov キーワード法令検索 (POST /gov/laws)
publicDataRoutes.post('/gov/laws', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = LawSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'keyword is required for law search', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchLaws(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Law search failed', 'GOV_ERROR', 500);
  }
});

// e-Gov 法令条文・本文詳細取得 (POST /gov/law-text)
publicDataRoutes.post('/gov/law-text', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = LawDataRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'lawId is required for law text retrieval', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await getLawData(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Law text retrieval failed', 'GOV_ERROR', 500);
  }
});

// 国会会議録検索 (POST /gov/diet-minutes & GET /gov/diet-minutes)
publicDataRoutes.post('/gov/diet-minutes', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = DietMinutesSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid diet minutes search parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchDietMinutes(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Diet minutes search failed', 'GOV_ERROR', 500);
  }
});

publicDataRoutes.get('/gov/diet-minutes', async (c) => {
  const keyword = c.req.query('keyword') || c.req.query('query') || c.req.query('any');
  const speaker = c.req.query('speaker');
  const nameOfHouse = c.req.query('nameOfHouse') as '衆議院' | '参議院' | undefined;
  const nameOfMeeting = c.req.query('nameOfMeeting') || c.req.query('meeting');
  const from = c.req.query('from');
  const until = c.req.query('until');
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await searchDietMinutes({
      keyword,
      speaker,
      nameOfHouse,
      nameOfMeeting,
      from,
      until,
      limit,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Diet minutes search failed', 'GOV_ERROR', 500);
  }
});

// 国土地理院 住所ジオコーディング & 標高取得 (POST /geo/elevation & GET /geo/elevation)
publicDataRoutes.post('/geo/elevation', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = ElevationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid elevation parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchElevationAndCoordinates(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Elevation fetch failed', 'GEO_ERROR', 500);
  }
});

publicDataRoutes.get('/geo/elevation', async (c) => {
  const address = c.req.query('address') || c.req.query('q');
  const latStr = c.req.query('lat');
  const lonStr = c.req.query('lon');
  const lat = latStr ? parseFloat(latStr) : undefined;
  const lon = lonStr ? parseFloat(lonStr) : undefined;
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchElevationAndCoordinates({
      address,
      lat,
      lon,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Elevation fetch failed', 'GEO_ERROR', 500);
  }
});

// 主要空港フライト運航状況検索 (POST /traffic/flight, GET /traffic/flight, GET /traffic/flight/:airport)
publicDataRoutes.post('/traffic/flight', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = FlightStatusRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid flight status parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchFlightStatus(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

publicDataRoutes.get('/traffic/flight', async (c) => {
  const airport = c.req.query('airport');
  const type = c.req.query('type') as 'departure' | 'arrival' | undefined;
  const category = c.req.query('category') as 'domestic' | 'international' | undefined;
  const flightNumber = c.req.query('flightNumber') || c.req.query('flight');
  const keyword = c.req.query('keyword') || c.req.query('query');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchFlightStatus({
      airport,
      type,
      category,
      flightNumber,
      keyword,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

publicDataRoutes.get('/traffic/flight/:airport', async (c) => {
  const airport = c.req.param('airport');
  const type = c.req.query('type') as 'departure' | 'arrival' | undefined;
  const category = c.req.query('category') as 'domestic' | 'international' | undefined;
  const flightNumber = c.req.query('flightNumber') || c.req.query('flight');
  const keyword = c.req.query('keyword') || c.req.query('query');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchFlightStatus({
      airport,
      type,
      category,
      flightNumber,
      keyword,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});
