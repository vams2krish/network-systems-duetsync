-- Private room state. Browsers have no table access; the server uses one narrowly scoped RPC.
create schema if not exists duet_private;
revoke all on schema duet_private from public, anon, authenticated;
create table duet_private.config (singleton boolean primary key default true check(singleton), secret_hash text not null);
create table duet_private.rooms (key text primary key, version bigint not null, data jsonb not null, expires bigint not null);
create index rooms_expiry on duet_private.rooms(expires);
create table duet_private.rates (key text primary key, count integer not null, expires bigint not null);
create index rates_expiry on duet_private.rates(expires);
alter table duet_private.config enable row level security;
alter table duet_private.rooms enable row level security;
alter table duet_private.rates enable row level security;
revoke all on all tables in schema duet_private from public, anon, authenticated;

create or replace function public.duet_store(p_secret text, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  row_data duet_private.rooms%rowtype;
  k text := p_payload->>'key';
  expected bigint;
  written bigint;
  amount integer;
  bucket bigint;
begin
  if not exists(select 1 from duet_private.config where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_action = 'health' then return 'true'::jsonb;
  elsif p_action = 'load' then
    select * into row_data from duet_private.rooms where key=k and expires>now_ms;
    if not found then return 'null'::jsonb; end if;
    return jsonb_build_object('version',row_data.version,'data',row_data.data,'expires',row_data.expires);
  elsif p_action = 'save' then
    expected := (p_payload->>'version')::bigint;
    if expected=0 then
      insert into duet_private.rooms(key,version,data,expires)
      values(k,1,p_payload->'data',(p_payload->>'expires')::bigint)
      on conflict(key) do update set version=1,data=excluded.data,expires=excluded.expires where duet_private.rooms.expires<=now_ms;
    else
      update duet_private.rooms set version=expected+1,data=p_payload->'data',expires=(p_payload->>'expires')::bigint
      where key=k and version=expected and expires>now_ms;
    end if;
    get diagnostics written = row_count;
    return to_jsonb(written=1);
  elsif p_action='limit' then
    bucket := now_ms / (p_payload->>'window')::bigint;
    k := k || ':' || bucket;
    insert into duet_private.rates(key,count,expires) values(k,1,now_ms+(p_payload->>'window')::bigint*2)
    on conflict(key) do update set count=duet_private.rates.count+1 returning count into amount;
    return to_jsonb(amount <= (p_payload->>'max')::integer);
  elsif p_action='cleanup' then
    delete from duet_private.rooms where expires<=now_ms;
    delete from duet_private.rates where expires<=now_ms;
    return 'true'::jsonb;
  end if;
  raise exception 'Unknown storage action';
end;
$$;
revoke all on function public.duet_store(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.duet_store(text,text,jsonb) to anon;
-- Provision config.secret_hash separately from a generated server credential.
-- Never put the plaintext DUET_BACKEND_SECRET in a migration or browser asset.
