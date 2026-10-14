/**
 * Deterministic regression fixture: missing local-profile bias coverage and
 * UTC leap-second notation incorrectly declared as TAI. Everything else is
 * healthy, so adding a bias and correcting that source declaration is enough.
 */
export const boundaryRegressionBundle = {
  metadata: {
    SIMPLE: true,
    BITPIX: -32,
    NAXIS: 2,
    NAXIS1: 2048,
    NAXIS2: 2048,
    OBJECT: 'M31',
    TARGET: 'M31',
    'DATE-OBS': '2016-12-31T23:59:30Z',
    TIMESYS: 'UTC',
    'MJD-OBS': 57753.99965277778,
    OBSERVAT: 'Cerro Paranal',
    TELESCOP: 'VLT-UT1',
    TELESCOPE_SITE: 'Cerro Paranal',
    EXPTIME: 30,
  },
  observatory: { name: 'Cerro Paranal' },
  telescope: { name: 'VLT-UT1', observatory: 'Cerro Paranal' },
  target: {
    name: 'M31',
    coordinates: { raDeg: 10.6847, decDeg: 41.2688, frame: 'ICRS' },
  },
  exposureLogs: [
    {
      id: 'boundary-utc-001',
      start: '2016-12-31T23:59:30Z',
      timeSystem: 'UTC',
      exposure: 30,
      exposureUnit: 's',
      filter: 'R',
      airmass: 1.2,
      altitudeDeg: 50,
    },
    {
      id: 'boundary-tai-002',
      start: '2016-12-31T23:59:60Z',
      timeSystem: 'TAI',
      exposure: 30,
      exposureUnit: 's',
      filter: 'R',
      airmass: 1.22,
      altitudeDeg: 49,
    },
  ],
  calibrationFrames: [
    { id: 'dark-r-30s', type: 'dark', filter: 'R', exposure: 30, exposureUnit: 's' },
    { id: 'flat-r-5s', type: 'flat', filter: 'R', exposure: 5, exposureUnit: 's' },
  ],
  weather: {
    id: 'boundary-weather',
    temperatureC: 10,
    humidityPct: 45,
    windSpeedMps: 3,
    pressureHpa: 745,
  },
};
