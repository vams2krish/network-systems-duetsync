create extension if not exists pg_cron;
select cron.schedule('duetsync-expired-state', '*/10 * * * *', $job$
  delete from duet_private.rooms where expires < floor(extract(epoch from now()) * 1000);
  delete from duet_private.rates where expires < floor(extract(epoch from now()) * 1000);
$job$);
