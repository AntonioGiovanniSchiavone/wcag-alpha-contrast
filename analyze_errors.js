const Database = require('better-sqlite3');
const db = new Database('data/crawl_results.sqlite');

console.log('=== SITE STATUS ===');
db.prepare('SELECT status, COUNT(*) as n FROM sites GROUP BY status').all()
  .forEach(r => console.log(r.status + ': ' + r.n));

console.log('\n=== ERROR CLASSIFICATION ===');
db.prepare(`
  SELECT 
    CASE 
      WHEN error_msg LIKE '%ERR_NAME_NOT_RESOLVED%' THEN 'DNS not resolved (infrastructure)'
      WHEN error_msg LIKE '%ERR_CONNECTION_REFUSED%' THEN 'Connection refused'
      WHEN error_msg LIKE '%ERR_CONNECTION_RESET%' THEN 'Connection reset'
      WHEN error_msg LIKE '%Timeout%' OR error_msg LIKE '%timeout%' THEN 'Timeout'
      WHEN error_msg LIKE '%ERR_CERT%' THEN 'SSL/Certificate error'
      WHEN error_msg LIKE '%ERR_TUNNEL%' THEN 'Tunnel/proxy error'
      WHEN error_msg LIKE '%No data extracted%' THEN 'Page loaded, no content'
      WHEN error_msg LIKE '%ERR_ABORTED%' THEN 'Navigation aborted'
      WHEN error_msg LIKE '%ERR_TOO_MANY_REDIRECTS%' THEN 'Too many redirects'
      ELSE 'Other'
    END as reason,
    COUNT(*) as n
  FROM sites WHERE status = 'error'
  GROUP BY reason ORDER BY n DESC
`).all().forEach(r => console.log('  ' + r.reason + ': ' + r.n));

console.log('\n=== SAMPLE ERRORS ===');
db.prepare("SELECT rank, domain, SUBSTR(error_msg, 1, 80) as err FROM sites WHERE status = 'error' ORDER BY rank LIMIT 20").all()
  .forEach(r => console.log('  ' + r.rank + '. ' + r.domain + ' — ' + r.err));

db.close();