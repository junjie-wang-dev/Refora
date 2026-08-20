create schema if not exists refora_sync;

revoke all on schema refora_sync from public, anon, authenticated;

create table refora_sync.libraries (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table refora_sync.devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table refora_sync.library_sequences (
  library_id uuid primary key references refora_sync.libraries(id) on delete cascade,
  value bigint not null default 0 check (value >= 0)
);

create table refora_sync.entities (
  library_id uuid not null references refora_sync.libraries(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'document_user_data',
    'category',
    'document_category',
    'workspace',
    'workspace_note',
    'workspace_layout',
    'workspace_connection',
    'pdf_annotation',
    'agent_memory'
  )),
  entity_id text not null check (char_length(entity_id) between 1 and 200),
  version bigint not null check (version > 0),
  sequence bigint not null check (sequence > 0),
  deleted boolean not null default false,
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576
  ),
  updated_by uuid not null references refora_sync.devices(id),
  updated_at timestamptz not null default now(),
  primary key (library_id, entity_type, entity_id),
  unique (library_id, sequence)
);

create index sync_entities_pull_idx
on refora_sync.entities(library_id, sequence);

create table refora_sync.operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  library_id uuid not null references refora_sync.libraries(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  primary key (user_id, operation_id)
);

create index sync_operations_expiry_idx
on refora_sync.operations(expires_at);

create table refora_sync.device_cursors (
  device_id uuid not null references refora_sync.devices(id) on delete cascade,
  library_id uuid not null references refora_sync.libraries(id) on delete cascade,
  cursor bigint not null default 0 check (cursor >= 0),
  updated_at timestamptz not null default now(),
  primary key (device_id, library_id)
);

alter table refora_sync.libraries enable row level security;
alter table refora_sync.devices enable row level security;
alter table refora_sync.library_sequences enable row level security;
alter table refora_sync.entities enable row level security;
alter table refora_sync.operations enable row level security;
alter table refora_sync.device_cursors enable row level security;

revoke all on all tables in schema refora_sync from public, anon, authenticated;
revoke all on all sequences in schema refora_sync from public, anon, authenticated;

create or replace function public.refora_sync_register_library(
  p_library_id uuid,
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
  if p_library_id is null then
    raise exception 'Invalid library id' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    raise exception 'Invalid library name' using errcode = '22023';
  end if;

  insert into refora_sync.libraries (id, owner_id, name)
  values (p_library_id, v_user_id, btrim(p_name))
  on conflict (id) do update
  set name = excluded.name,
      updated_at = now()
  where refora_sync.libraries.owner_id = v_user_id;

  if not exists (
    select 1 from refora_sync.libraries
    where id = p_library_id and owner_id = v_user_id
  ) then
    raise exception 'Library access denied' using errcode = '42501';
  end if;

  insert into refora_sync.library_sequences (library_id)
  values (p_library_id)
  on conflict (library_id) do nothing;
end;
$$;

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
  v_existing refora_sync.entities%rowtype;
  v_sequence bigint;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_library_id is null or p_device_id is null or p_operation_id is null then
    raise exception 'Invalid sync identity' using errcode = '22023';
  end if;
  if p_base_version is null or p_base_version < 0 then
    raise exception 'Invalid base version' using errcode = '22023';
  end if;
  if p_deleted is null then
    raise exception 'Invalid deletion state' using errcode = '22023';
  end if;
  if p_entity_type is null or p_entity_type not in (
    'document_user_data',
    'category',
    'document_category',
    'workspace',
    'workspace_note',
    'workspace_layout',
    'workspace_connection',
    'pdf_annotation',
    'agent_memory'
  ) then
    raise exception 'Entity type is not syncable' using errcode = '22023';
  end if;
  if p_entity_id is null or char_length(p_entity_id) not between 1 and 200 then
    raise exception 'Invalid entity id' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Payload must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p_payload::text) > 1048576 then
    raise exception 'Payload is too large' using errcode = '22023';
  end if;
  if not exists (
    select 1 from refora_sync.libraries
    where id = p_library_id and owner_id = v_user_id
  ) then
    raise exception 'Library access denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from refora_sync.devices
    where id = p_device_id and user_id = v_user_id
  ) then
    raise exception 'Device access denied' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|' || p_operation_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_library_id::text || '|' || p_entity_type || '|' || p_entity_id,
      0
    )
  );

  select result into v_result
  from refora_sync.operations
  where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    return v_result;
  end if;

  select * into v_existing
  from refora_sync.entities
  where library_id = p_library_id
    and entity_type = p_entity_type
    and entity_id = p_entity_id
  for update;

  if coalesce(v_existing.version, 0) <> p_base_version then
    v_result := jsonb_build_object(
      'status', 'conflict',
      'version', coalesce(v_existing.version, 0),
      'sequence', coalesce(v_existing.sequence, 0),
      'deleted', coalesce(v_existing.deleted, false),
      'payload', coalesce(v_existing.payload, '{}'::jsonb)
    );
    insert into refora_sync.operations (user_id, operation_id, library_id, result)
    values (v_user_id, p_operation_id, p_library_id, v_result);
    return v_result;
  end if;

  update refora_sync.library_sequences
  set value = value + 1
  where library_id = p_library_id
  returning value into v_sequence;
  if v_sequence is null then
    raise exception 'Library sequence is missing' using errcode = '55000';
  end if;

  insert into refora_sync.entities (
    library_id,
    entity_type,
    entity_id,
    version,
    sequence,
    deleted,
    payload,
    updated_by
  ) values (
    p_library_id,
    p_entity_type,
    p_entity_id,
    p_base_version + 1,
    v_sequence,
    p_deleted,
    p_payload,
    p_device_id
  )
  on conflict (library_id, entity_type, entity_id) do update
  set version = excluded.version,
      sequence = excluded.sequence,
      deleted = excluded.deleted,
      payload = excluded.payload,
      updated_by = excluded.updated_by,
      updated_at = now();

  v_result := jsonb_build_object(
    'status', 'applied',
    'version', p_base_version + 1,
    'sequence', v_sequence
  );

  insert into refora_sync.operations (user_id, operation_id, library_id, result)
  values (v_user_id, p_operation_id, p_library_id, v_result);

  delete from refora_sync.operations
  where user_id = v_user_id and expires_at < now();

  return v_result;
end;
$$;

create or replace function public.refora_sync_pull(
  p_library_id uuid,
  p_after bigint,
  p_limit integer default 500
)
returns table (
  entity_type text,
  entity_id text,
  version bigint,
  sequence bigint,
  deleted boolean,
  payload jsonb,
  updated_at timestamptz
)
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
  if p_library_id is null
    or p_after is null
    or p_limit is null
    or p_after < 0
    or p_limit < 1
    or p_limit > 1000 then
    raise exception 'Invalid pull range' using errcode = '22023';
  end if;
  if not exists (
    select 1 from refora_sync.libraries
    where id = p_library_id and owner_id = v_user_id
  ) then
    raise exception 'Library access denied' using errcode = '42501';
  end if;

  return query
  select
    e.entity_type,
    e.entity_id,
    e.version,
    e.sequence,
    e.deleted,
    e.payload,
    e.updated_at
  from refora_sync.entities e
  where e.library_id = p_library_id and e.sequence > p_after
  order by e.sequence
  limit p_limit;
end;
$$;

create or replace function public.refora_sync_save_cursor(
  p_library_id uuid,
  p_device_id uuid,
  p_cursor bigint
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
  if p_library_id is null or p_device_id is null or p_cursor is null or p_cursor < 0 then
    raise exception 'Invalid cursor' using errcode = '22023';
  end if;
  if not exists (
    select 1 from refora_sync.libraries
    where id = p_library_id and owner_id = v_user_id
  ) or not exists (
    select 1 from refora_sync.devices
    where id = p_device_id and user_id = v_user_id
  ) then
    raise exception 'Sync access denied' using errcode = '42501';
  end if;

  insert into refora_sync.device_cursors (device_id, library_id, cursor)
  values (p_device_id, p_library_id, p_cursor)
  on conflict (device_id, library_id) do update
  set cursor = greatest(refora_sync.device_cursors.cursor, excluded.cursor),
      updated_at = now();

  update refora_sync.devices
  set last_seen_at = now()
  where id = p_device_id and user_id = v_user_id;
end;
$$;

revoke all on function public.refora_sync_register_library(uuid, text) from public, anon;
revoke all on function public.refora_sync_register_device(uuid, text) from public, anon;
revoke all on function public.refora_sync_push(uuid, uuid, uuid, text, text, bigint, boolean, jsonb) from public, anon;
revoke all on function public.refora_sync_pull(uuid, bigint, integer) from public, anon;
revoke all on function public.refora_sync_save_cursor(uuid, uuid, bigint) from public, anon;

grant execute on function public.refora_sync_register_library(uuid, text) to authenticated;
grant execute on function public.refora_sync_register_device(uuid, text) to authenticated;
grant execute on function public.refora_sync_push(uuid, uuid, uuid, text, text, bigint, boolean, jsonb) to authenticated;
grant execute on function public.refora_sync_pull(uuid, bigint, integer) to authenticated;
grant execute on function public.refora_sync_save_cursor(uuid, uuid, bigint) to authenticated;
