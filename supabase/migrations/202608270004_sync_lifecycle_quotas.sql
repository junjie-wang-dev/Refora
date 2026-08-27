update refora_sync.libraries
set entity_count = 0,
    payload_bytes = 0;

update refora_sync.libraries l
set entity_count = counts.entity_count,
    payload_bytes = counts.payload_bytes
from (
  select
    library_id,
    count(*)::bigint as entity_count,
    coalesce(sum(octet_length(payload::text)), 0)::bigint as payload_bytes
  from refora_sync.entities
  where not deleted
  group by library_id
) counts
where l.id = counts.library_id;

create index sync_devices_user_last_seen_idx
on refora_sync.devices(user_id, last_seen_at);

create or replace function public.refora_sync_register_device(
  p_device_id uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_device_id is null then
    raise exception 'Invalid device id' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    raise exception 'Invalid device name' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );
  if not exists (
    select 1 from refora_sync.devices
    where id = p_device_id and user_id = v_user_id
  ) and (
    select count(*)
    from refora_sync.devices
    where user_id = v_user_id
      and last_seen_at >= now() - interval '180 days'
  ) >= 20 then
    raise exception 'Account device quota exceeded' using errcode = '54000';
  end if;

  insert into refora_sync.devices (id, user_id, name)
  values (p_device_id, v_user_id, btrim(p_name))
  on conflict (id) do update
  set name = excluded.name,
      last_seen_at = now()
  where refora_sync.devices.user_id = v_user_id;

  if not exists (
    select 1 from refora_sync.devices
    where id = p_device_id and user_id = v_user_id
  ) then
    raise exception 'Device access denied' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.refora_sync_push(
  p_library_id uuid,
  p_device_id uuid,
  p_operation_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_base_version bigint,
  p_deleted boolean,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
  v_existing refora_sync.entities%rowtype;
  v_entity_exists boolean;
  v_old_active boolean;
  v_new_active boolean;
  v_old_payload_bytes bigint;
  v_new_payload_bytes bigint;
  v_library_entity_count bigint;
  v_library_payload_bytes bigint;
  v_next_library_entity_count bigint;
  v_next_library_payload_bytes bigint;
  v_user_entity_count bigint;
  v_user_payload_bytes bigint;
  v_legacy_entity_delta bigint;
  v_legacy_payload_delta bigint;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );

  delete from refora_sync.operations
  where user_id = v_user_id and expires_at < now();

  if exists (
    select 1
    from refora_sync.operations
    where user_id = v_user_id and operation_id = p_operation_id
  ) then
    return public.refora_sync_push_v2_internal(
      p_library_id,
      p_device_id,
      p_operation_id,
      p_entity_type,
      p_entity_id,
      p_base_version,
      p_deleted,
      p_payload
    );
  end if;

  if (
    select count(*)
    from refora_sync.operations
    where user_id = v_user_id
  ) >= 20000 then
    raise exception 'Account sync operation quota exceeded' using errcode = '54000';
  end if;

  if p_entity_type = 'category' and p_payload ? 'moveToLibrary' then
    raise exception 'Category contains unsupported fields' using errcode = '22023';
  end if;

  if p_library_id is null
    or p_entity_type is null
    or p_entity_id is null
    or p_deleted is null
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object' then
    return public.refora_sync_push_v2_internal(
      p_library_id,
      p_device_id,
      p_operation_id,
      p_entity_type,
      p_entity_id,
      p_base_version,
      p_deleted,
      p_payload
    );
  end if;

  select entity_count, payload_bytes
  into v_library_entity_count, v_library_payload_bytes
  from refora_sync.libraries
  where id = p_library_id and owner_id = v_user_id
  for update;

  if not found then
    return public.refora_sync_push_v2_internal(
      p_library_id,
      p_device_id,
      p_operation_id,
      p_entity_type,
      p_entity_id,
      p_base_version,
      p_deleted,
      p_payload
    );
  end if;

  select * into v_existing
  from refora_sync.entities
  where library_id = p_library_id
    and entity_type = p_entity_type
    and entity_id = p_entity_id;
  v_entity_exists := found;
  v_old_active := v_entity_exists and not v_existing.deleted;
  v_new_active := not p_deleted;
  v_old_payload_bytes := case
    when v_old_active then octet_length(v_existing.payload::text)
    else 0
  end;
  v_new_payload_bytes := case
    when v_new_active then octet_length(p_payload::text)
    else 0
  end;
  v_next_library_entity_count := v_library_entity_count
    - case when v_old_active then 1 else 0 end
    + case when v_new_active then 1 else 0 end;
  v_next_library_payload_bytes := v_library_payload_bytes
    - v_old_payload_bytes
    + v_new_payload_bytes;

  select
    coalesce(sum(entity_count), 0),
    coalesce(sum(payload_bytes), 0)
  into v_user_entity_count, v_user_payload_bytes
  from refora_sync.libraries
  where owner_id = v_user_id;

  if v_next_library_entity_count > 100000
    or v_user_entity_count - v_library_entity_count + v_next_library_entity_count > 200000 then
    raise exception 'Account sync entity quota exceeded' using errcode = '54000';
  end if;
  if v_next_library_payload_bytes > 33554432
    or v_user_payload_bytes - v_library_payload_bytes + v_next_library_payload_bytes > 67108864 then
    raise exception 'Account sync storage quota exceeded' using errcode = '54000';
  end if;

  v_legacy_entity_delta := case when v_entity_exists then 0 else 1 end;
  v_legacy_payload_delta := octet_length(
    (case when p_deleted then '{}'::jsonb else p_payload end)::text
  ) - case
    when v_entity_exists then octet_length(v_existing.payload::text)
    else 0
  end;

  update refora_sync.libraries
  set entity_count = greatest(0, -v_legacy_entity_delta),
      payload_bytes = greatest(0, -v_legacy_payload_delta)
  where id = p_library_id and owner_id = v_user_id;

  v_result := public.refora_sync_push_v2_internal(
    p_library_id,
    p_device_id,
    p_operation_id,
    p_entity_type,
    p_entity_id,
    p_base_version,
    p_deleted,
    p_payload
  );

  update refora_sync.libraries l
  set entity_count = counts.entity_count,
      payload_bytes = counts.payload_bytes,
      updated_at = now()
  from (
    select
      count(*)::bigint as entity_count,
      coalesce(sum(octet_length(payload::text)), 0)::bigint as payload_bytes
    from refora_sync.entities
    where library_id = p_library_id and not deleted
  ) counts
  where l.id = p_library_id and l.owner_id = v_user_id;

  return v_result;
end;
$$;

revoke all on function public.refora_sync_register_device(uuid, text) from public, anon;
revoke all on function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) from public, anon;

grant execute on function public.refora_sync_register_device(uuid, text) to authenticated;
grant execute on function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) to authenticated;
