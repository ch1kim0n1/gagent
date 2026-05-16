import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<30000'],
  },
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: __ENV.DURATION || '1m',
    },
  },
};

const baseUrl = __ENV.GAGENT_URL || 'http://localhost:3000';

export default function () {
  const health = http.get(`${baseUrl}/health`);
  check(health, {
    'health is not 5xx': response => response.status < 500,
  });
  sleep(1);
}
