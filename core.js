// ============================================================
// RayWatch Platform — Core Schema, Engine & Mock API v2
// New: photo_urls[], telemetry_data, year filtering, trend analytics
// ============================================================

export const SCHEMA = {
  sighting: {
    id:            'uuid',
    submitted_at:  'timestamp',
    status:        'enum(pending|approved|rejected)',
    lat:           'float',
    lng:           'float',
    accuracy_m:    'int',
    count:         'int',
    behavior:      'enum(feeding|transiting|resting|unknown)',
    depth_m:       'float|null',
    water_temp_c:  'float|null',
    submitter_name:  'string|null',
    submitter_email: 'string|null',
    submitter_type:  'enum(public|researcher|fisherman)',
    photo_urls:      'string[]|null',   // NEW: array of photo URLs
    notes:           'string|null',
    reviewed_by:   'string|null',
    reviewed_at:   'timestamp|null',
    reject_reason: 'string|null',
    cell_lat:      'float',
    cell_lng:      'float',
    cell_size_deg: 'float',
  },

  telemetry_summary: {
    id:           'uuid',
    uploaded_at:  'timestamp',
    researcher:   'string',
    season:       'string',
    region:       'string',
    tag_count:    'int',
    track_count:  'int',
    cells: [{ cell_lat: 'float', cell_lng: 'float', density: 'float' }],
    notes: 'string|null',
  },

  risk_zone: {
    cell_lat:      'float',
    cell_lng:      'float',
    cell_size_deg: 'float',
    kde_intensity: 'float',
    fishing_weight:'float',
    risk_tier:     'enum(low|medium|high)',
    sighting_count:'int',
    season:        'string',
    updated_at:    'timestamp',
  },
};

// ── Generalization Engine ────────────────────────────────────

export const GeneralizationEngine = {
  CELL_SIZE: 0.15,
  MIN_K: 1,
  KDE_BANDWIDTH: 2,

  snapToGrid(lat, lng, cellSize = this.CELL_SIZE) {
    const cellLat = Math.floor(lat / cellSize) * cellSize + cellSize / 2;
    const cellLng = Math.floor(lng / cellSize) * cellSize + cellSize / 2;
    return { cell_lat: +cellLat.toFixed(5), cell_lng: +cellLng.toFixed(5), cell_size_deg: cellSize };
  },

  aggregateCells(sightings, cellSize = this.CELL_SIZE) {
  const cells = {};
  sightings.forEach(s => {
    const snapped = this.snapToGrid(s.lat, s.lng, cellSize);
    const key = `${snapped.cell_lat},${snapped.cell_lng}`;

    if (!cells[key]) {
      cells[key] = {
        ...snapped,
        count: 0,
        ray_count: 0,
        season_counts: {}
      };
    }

    cells[key].count++;
    cells[key].ray_count += s.count || 1;

    const season = this.getSeason(s.submitted_at);
    cells[key].season_counts[season] = (cells[key].season_counts[season] || 0) + 1;
  });

  return Object.values(cells).filter(c => c.count >= this.MIN_K);
}

  computeKDE(cells, bandwidth = this.KDE_BANDWIDTH, cellSize = this.CELL_SIZE) {
    const result = {};
    cells.forEach(source => {
      cells.forEach(target => {
        const dLat = (source.cell_lat - target.cell_lat) / cellSize;
        const dLng = (source.cell_lng - target.cell_lng) / cellSize;
        const d2 = dLat * dLat + dLng * dLng;
        if (d2 > bandwidth * bandwidth * 4) return;
        const weight = source.count * Math.exp(-0.5 * d2 / (bandwidth * bandwidth));
        const key = `${target.cell_lat},${target.cell_lng}`;
        result[key] = (result[key] || 0) + weight;
      });
    });
    const maxVal = Math.max(...Object.values(result), 1);
    return cells.map(c => ({
      ...c,
      kde_intensity: +((result[`${c.cell_lat},${c.cell_lng}`] || 0) / maxVal).toFixed(3),
    }));
  },

  scoreRisk(kdeCells, getFishingWeight) {
    return kdeCells.map(c => {
      const fw = getFishingWeight ? getFishingWeight(c.cell_lat, c.cell_lng) : 0.5;
      const score = c.kde_intensity * fw;
      return {
        ...c,
        fishing_weight: +fw.toFixed(3),
        risk_score: +score.toFixed(3),
        risk_tier: score > 0.35 ? 'high' : score > 0.12 ? 'medium' : 'low',
      };
    });
  },

  getSeason(ts) {
    const m = new Date(ts).getMonth();
    if (m >= 2 && m <= 4) return 'Spring';
    if (m >= 5 && m <= 7) return 'Summer';
    if (m >= 8 && m <= 10) return 'Fall';
    return 'Winter';
  },

  getYear(ts) {
    return new Date(ts).getFullYear();
  },

  process(sightings, getFishingWeight, cellSize = this.CELL_SIZE) {
    const cells = this.aggregateCells(sightings, cellSize);
    const kde   = this.computeKDE(cells, this.KDE_BANDWIDTH, cellSize);
    return this.scoreRisk(kde, getFishingWeight);
  },

  // ── NEW: Trend analytics ──────────────────────────────────

  /**
   * Returns sightings grouped by year: { 2023: [...], 2024: [...] }
   */
  groupByYear(sightings) {
    return sightings.reduce((acc, s) => {
      const y = this.getYear(s.submitted_at);
      if (!acc[y]) acc[y] = [];
      acc[y].push(s);
      return acc;
    }, {});
  },

  /**
   * Returns monthly trend data for chart rendering
   * { year, month (0-11), count, ray_count, avg_depth, avg_temp }
   */
  monthlyTrend(sightings) {
    const buckets = {};
    sightings.forEach(s => {
      const d = new Date(s.submitted_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!buckets[key]) buckets[key] = { year: d.getFullYear(), month: d.getMonth(), count: 0, ray_count: 0, depths: [], temps: [] };
      buckets[key].count++;
      buckets[key].ray_count += s.count || 1;
      if (s.depth_m != null) buckets[key].depths.push(s.depth_m);
      if (s.water_temp_c != null) buckets[key].temps.push(s.water_temp_c);
    });
    return Object.values(buckets).map(b => ({
      ...b,
      avg_depth: b.depths.length ? +(b.depths.reduce((a, v) => a + v, 0) / b.depths.length).toFixed(1) : null,
      avg_temp:  b.temps.length  ? +(b.temps.reduce((a, v) => a + v, 0)  / b.temps.length).toFixed(1)  : null,
    })).sort((a, b) => a.year - b.year || a.month - b.month);
  },

  /**
   * Returns yearly summary stats
   */
  yearlyStats(sightings) {
    const byYear = this.groupByYear(sightings);
    return Object.entries(byYear).map(([year, list]) => ({
      year: +year,
      sighting_count: list.length,
      total_rays: list.reduce((n, s) => n + (s.count || 1), 0),
      avg_count: +(list.reduce((n, s) => n + (s.count || 1), 0) / list.length).toFixed(1),
      by_season: {
        Spring: list.filter(s => this.getSeason(s.submitted_at) === 'Spring').length,
        Summer: list.filter(s => this.getSeason(s.submitted_at) === 'Summer').length,
        Fall:   list.filter(s => this.getSeason(s.submitted_at) === 'Fall').length,
        Winter: list.filter(s => this.getSeason(s.submitted_at) === 'Winter').length,
      },
      by_type: {
        public:     list.filter(s => s.submitter_type === 'public').length,
        fisherman:  list.filter(s => s.submitter_type === 'fisherman').length,
        researcher: list.filter(s => s.submitter_type === 'researcher').length,
      },
    })).sort((a, b) => a.year - b.year);
  },
};

// ── Mock Data Store ──────────────────────────────────────────

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

const SEED_SIGHTINGS = (() => {
  const r = rng(42);
  const clusters = [
    { lat: 36.85, lng: -75.98, name: 'Virginia Beach shelf' },
    { lat: 37.20, lng: -76.10, name: 'Chesapeake mouth' },
    { lat: 36.60, lng: -75.80, name: 'Outer Banks north' },
    { lat: 37.80, lng: -76.30, name: 'Chesapeake mid-bay' },
    { lat: 36.40, lng: -75.70, name: 'Pamlico Sound' },
  ];
  const behaviors = ['feeding', 'transiting', 'resting', 'unknown'];
  const statuses = ['approved', 'approved', 'approved', 'approved', 'pending', 'pending', 'rejected'];
  const now = Date.now();
  const sightings = [];

  // Generate across multiple years for trend data
  const yearsBack = [0, 365, 730, 1095]; // this year, 1yr, 2yr, 3yr ago
  for (let i = 0; i < 120; i++) {
    const c = clusters[Math.floor(r() * clusters.length)];
    const lat = c.lat + (r() - 0.5) * 0.6;
    const lng = c.lng + (r() - 0.5) * 0.5;
    const yearOffset = yearsBack[Math.floor(r() * yearsBack.length)];
    const daysAgo = yearOffset + Math.floor(r() * 365);
    const status = statuses[Math.floor(r() * statuses.length)];
    sightings.push({
      id: uuid(),
      submitted_at: new Date(now - daysAgo * 86400000).toISOString(),
      status,
      lat: +lat.toFixed(5),
      lng: +lng.toFixed(5),
      accuracy_m: Math.round(5 + r() * 30),
      count: Math.round(1 + r() * r() * 120),
      behavior: behaviors[Math.floor(r() * behaviors.length)],
      depth_m: r() > 0.4 ? +(2 + r() * 18).toFixed(1) : null,
      water_temp_c: r() > 0.3 ? +(14 + r() * 14).toFixed(1) : null,
      submitter_name: r() > 0.5 ? ['J. Martinez', 'K. Oduya', 'T. Brennan', 'S. Park', 'A. Williams'][Math.floor(r() * 5)] : null,
      submitter_email: null,
      submitter_type: ['public', 'public', 'public', 'fisherman', 'researcher'][Math.floor(r() * 5)],
      // NEW: photo_urls array
      photo_urls: r() > 0.6 ? [`https://picsum.photos/seed/${i}/400/300`, r() > 0.8 ? `https://picsum.photos/seed/${i+50}/400/300` : null].filter(Boolean) : null,
      notes: r() > 0.7 ? ['Large aggregation near surface', 'Moving SW', 'Feeding on bivalves', 'Schools visible from pier'][Math.floor(r() * 4)] : null,
      reviewed_by: status !== 'pending' ? 'admin@raywatch.org' : null,
      reviewed_at: status !== 'pending' ? new Date(now - (daysAgo - 1) * 86400000).toISOString() : null,
      reject_reason: status === 'rejected' ? 'Coordinates outside survey region' : null,
      ...GeneralizationEngine.snapToGrid(lat, lng),
    });
  }
  return sightings;
})();

// ── Mock API ─────────────────────────────────────────────────

export const API = {
  _store: [...SEED_SIGHTINGS],

  delay: (ms = 200) => new Promise(r => setTimeout(r, ms + Math.random() * 150)),

  async submitSighting(data) {
    await this.delay(400);
    const id = uuid();
    const sighting = {
      id,
      submitted_at: new Date().toISOString(),
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reject_reason: null,
      ...data,
      ...GeneralizationEngine.snapToGrid(data.lat, data.lng),
    };
    this._store.push(sighting);
    return { ok: true, id, sighting };
  },

  async getPending() {
    await this.delay();
    return this._store.filter(s => s.status === 'pending')
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  },

  async getAll() {
    await this.delay();
    return [...this._store].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  },

  async getByYear(year) {
    await this.delay();
    return this._store.filter(s => GeneralizationEngine.getYear(s.submitted_at) === year);
  },

  async reviewSighting(id, action, reason = null) {
    await this.delay(300);
    const s = this._store.find(s => s.id === id);
    if (!s) return { ok: false, error: 'Not found' };
    s.status = action === 'approve' ? 'approved' : 'rejected';
    s.reviewed_by = 'admin@raywatch.org';
    s.reviewed_at = new Date().toISOString();
    s.reject_reason = reason;
    return { ok: true, sighting: s };
  },

  async getPublicRiskZones(season = null, year = null) {
    await this.delay();
    let approved = this._store.filter(s => s.status === 'approved');
    if (season) approved = approved.filter(s => GeneralizationEngine.getSeason(s.submitted_at) === season);
    if (year)   approved = approved.filter(s => GeneralizationEngine.getYear(s.submitted_at) === year);
    const getFishingWeight = (lat, lng) => {
      const coastalProx = Math.max(0, 1 - Math.abs(lng + 75.9) * 3);
      return Math.min(1, 0.2 + coastalProx * 0.8);
    };
    return GeneralizationEngine.process(approved, getFishingWeight);
  },

  async getStats() {
    await this.delay(100);
    const all = this._store;
    return {
      total: all.length,
      pending: all.filter(s => s.status === 'pending').length,
      approved: all.filter(s => s.status === 'approved').length,
      rejected: all.filter(s => s.status === 'rejected').length,
      total_rays: all.filter(s => s.status === 'approved').reduce((n, s) => n + (s.count || 1), 0),
    };
  },

  // NEW: Trend data
  async getTrends() {
    await this.delay(150);
    const approved = this._store.filter(s => s.status === 'approved');
    return {
      monthly: GeneralizationEngine.monthlyTrend(approved),
      yearly:  GeneralizationEngine.yearlyStats(approved),
      availableYears: [...new Set(approved.map(s => GeneralizationEngine.getYear(s.submitted_at)))].sort(),
    };
  },

  // NEW: Upload telemetry (real file processing stub)
  async uploadTelemetry(fileData, meta) {
    await this.delay(900);
    return {
      ok: true,
      id: uuid(),
      uploaded_at: new Date().toISOString(),
      ...meta,
      cells_generated: Math.floor(8 + Math.random() * 20),
    };
  },

  // NEW: Upload photo and return URL
  async uploadPhoto(file, sightingId) {
    await this.delay(600);
    // In production: upload to Supabase Storage / Cloudinary
    // For now returns a mock URL
    return { ok: true, url: URL.createObjectURL(file) };
  },
};

export default { SCHEMA, GeneralizationEngine, API };
