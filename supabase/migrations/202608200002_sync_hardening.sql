update refora_sync.entities
set payload = '{}'::jsonb
where deleted;

alter table refora_sync.libraries
add column entity_count bigint not null default 0;

alter table refora_sync.libraries
add column payload_bytes bigint not null default 0;

update refora_sync.libraries l
set entity_count = counts.entity_count,
    payload_bytes = counts.payload_bytes
from (
  select
    library_id,
    count(*)::bigint as entity_count,
    coalesce(sum(octet_length(payload::text)), 0)::bigint as payload_bytes
  from refora_sync.entities
  group by library_id
) counts
where l.id = counts.library_id;

alter table refora_sync.libraries
add constraint sync_libraries_entity_count_valid
check (entity_count between 0 and 100000);

alter table refora_sync.libraries
add constraint sync_libraries_payload_bytes_valid
check (payload_bytes between 0 and 33554432);

alter table refora_sync.entities
add constraint sync_entities_deleted_payload_empty
check (not deleted or payload = '{}'::jsonb);

alter table refora_sync.operations
add column request_hash text not null default 'legacy';

alter table refora_sync.operations
alter column request_hash drop default;

alter table refora_sync.operations
add constraint sync_operations_request_hash_valid
check (char_length(request_hash) between 1 and 64);

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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );
  if not exists (
    select 1 from refora_sync.libraries
    where id = p_library_id and owner_id = v_user_id
  ) and (
    select count(*) from refora_sync.libraries where owner_id = v_user_id
  ) >= 20 then
    raise exception 'Account library quota exceeded' using errcode = '54000';
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );
  if not exists (
    select 1 from refora_sync.devices
    where id = p_device_id and user_id = v_user_id
  ) and (
    select count(*) from refora_sync.devices where user_id = v_user_id
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
  v_existing refora_sync.entities%rowtype;
  v_sequence bigint;
  v_result jsonb;
  v_payload jsonb;
  v_request_hash text;
  v_stored_request_hash text;
  v_entity_exists boolean;
  v_old_payload_bytes bigint;
  v_new_payload_bytes bigint;
  v_entity_delta bigint;
  v_payload_delta bigint;
  v_user_entity_count bigint;
  v_user_payload_bytes bigint;
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
  if p_deleted and p_payload <> '{}'::jsonb then
    raise exception 'Deleted entities cannot retain a payload' using errcode = '22023';
  end if;
  if not p_deleted then
    if p_entity_type = 'document_user_data' and p_payload - array[
      'note',
      'starred',
      'lastReadAt',
      'editedFields'
    ] <> '{}'::jsonb then
      raise exception 'Document user data contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'category' and p_payload - array[
      'name',
      'sortOrder',
      'moveToLibrary',
      'createdAt'
    ] <> '{}'::jsonb then
      raise exception 'Category contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'document_category' and p_payload - array[
      'documentHash',
      'categoryId'
    ] <> '{}'::jsonb then
      raise exception 'Document category contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'workspace' and p_payload - array[
      'name',
      'createdAt',
      'updatedAt'
    ] <> '{}'::jsonb then
      raise exception 'Workspace contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'workspace_note' and p_payload - array[
      'workspaceId',
      'title',
      'contentMd',
      'noteType',
      'color',
      'createdAt',
      'updatedAt'
    ] <> '{}'::jsonb then
      raise exception 'Workspace note contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'workspace_layout' and p_payload - array[
      'recordType',
      'workspaceId',
      'kind',
      'documentHash',
      'noteId',
      'sortOrder',
      'width',
      'height',
      'x',
      'y',
      'zIndex',
      'addedAt',
      'panX',
      'panY',
      'zoom',
      'updatedAt'
    ] <> '{}'::jsonb then
      raise exception 'Workspace layout contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'workspace_connection' and p_payload - array[
      'workspaceId',
      'sourceItemId',
      'targetItemId',
      'sourceAnchor',
      'targetAnchor',
      'createdAt'
    ] <> '{}'::jsonb then
      raise exception 'Workspace connection contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'pdf_annotation' and p_payload - array[
      'annotations',
      'updatedAt'
    ] <> '{}'::jsonb then
      raise exception 'PDF annotation contains unsupported fields' using errcode = '22023';
    elsif p_entity_type = 'agent_memory' and p_payload - array[
      'scope',
      'scopeId',
      'workspaceId',
      'path',
      'content',
      'revision',
      'createdAt',
      'updatedAt'
    ] <> '{}'::jsonb then
      raise exception 'Agent memory contains unsupported fields' using errcode = '22023';
    end if;
  end if;
  if p_entity_type in ('document_user_data', 'pdf_annotation')
    and p_entity_id !~ '^[0-9a-f]{64}$' then
    raise exception 'Document entities must use a SHA-256 entity id' using errcode = '22023';
  end if;
  if p_entity_type = 'document_user_data'
    and p_payload ? 'editedFields'
    and (
      jsonb_typeof(p_payload -> 'editedFields') <> 'object'
      or (p_payload -> 'editedFields') - array[
        'title',
        'authors',
        'year',
        'venue',
        'volume',
        'issue',
        'pages',
        'abstract',
        'keywords',
        'url',
        'doi',
        'arxivId',
        'affiliations'
      ] <> '{}'::jsonb
    ) then
    raise exception 'Edited document metadata contains unsupported fields' using errcode = '22023';
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

  v_payload := case when p_deleted then '{}'::jsonb else p_payload end;
  v_request_hash := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_library_id::text,
    p_device_id::text,
    p_entity_type,
    p_entity_id,
    p_base_version,
    p_deleted,
    v_payload
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|' || p_operation_id::text, 0)
  );

  select result, request_hash into v_result, v_stored_request_hash
  from refora_sync.operations
  where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_stored_request_hash <> v_request_hash then
      raise exception 'Operation id was reused for a different request' using errcode = '22023';
    end if;
    return v_result;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_library_id::text || '|' || p_entity_type || '|' || p_entity_id,
      0
    )
  );

  select * into v_existing
  from refora_sync.entities
  where library_id = p_library_id
    and entity_type = p_entity_type
    and entity_id = p_entity_id
  for update;
  v_entity_exists := found;

  if coalesce(v_existing.version, 0) <> p_base_version then
    v_result := jsonb_build_object(
      'status', 'conflict',
      'version', coalesce(v_existing.version, 0),
      'sequence', coalesce(v_existing.sequence, 0),
      'deleted', coalesce(v_existing.deleted, false),
      'payload', coalesce(v_existing.payload, '{}'::jsonb)
    );
    insert into refora_sync.operations (
      user_id,
      operation_id,
      library_id,
      request_hash,
      result
    ) values (
      v_user_id,
      p_operation_id,
      p_library_id,
      v_request_hash,
      v_result
    );
    return v_result;
  end if;

  v_old_payload_bytes := case
    when v_entity_exists then octet_length(v_existing.payload::text)
    else 0
  end;
  v_new_payload_bytes := octet_length(v_payload::text);
  v_entity_delta := case when v_entity_exists then 0 else 1 end;
  v_payload_delta := v_new_payload_bytes - v_old_payload_bytes;

  select
    coalesce(sum(entity_count), 0),
    coalesce(sum(payload_bytes), 0)
  into v_user_entity_count, v_user_payload_bytes
  from refora_sync.libraries
  where owner_id = v_user_id;

  if v_user_entity_count + v_entity_delta > 200000 then
    raise exception 'Account sync entity quota exceeded' using errcode = '54000';
  end if;
  if v_user_payload_bytes + v_payload_delta > 67108864 then
    raise exception 'Account sync storage quota exceeded' using errcode = '54000';
  end if;

  update refora_sync.libraries
  set entity_count = entity_count + v_entity_delta,
      payload_bytes = payload_bytes + v_payload_delta,
      updated_at = now()
  where id = p_library_id and owner_id = v_user_id;

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
    v_payload,
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

  insert into refora_sync.operations (
    user_id,
    operation_id,
    library_id,
    request_hash,
    result
  ) values (
    v_user_id,
    p_operation_id,
    p_library_id,
    v_request_hash,
    v_result
  );

  delete from refora_sync.operations
  where user_id = v_user_id and expires_at < now();

  return v_result;
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
  v_max_cursor bigint;
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

  select value into v_max_cursor
  from refora_sync.library_sequences
  where library_id = p_library_id;
  if v_max_cursor is null or p_cursor > v_max_cursor then
    raise exception 'Cursor exceeds the library sequence' using errcode = '22023';
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

create or replace function public.refora_sync_list_libraries()
returns table (
  id uuid,
  name text,
  entity_count bigint,
  payload_bytes bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    l.id,
    l.name,
    l.entity_count,
    l.payload_bytes,
    l.created_at,
    l.updated_at
  from refora_sync.libraries l
  where l.owner_id = auth.uid()
  order by l.updated_at desc, l.id;
$$;

create or replace function public.refora_sync_delete_library(
  p_library_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted_count bigint;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_library_id is null then
    raise exception 'Invalid library id' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );
  delete from refora_sync.libraries
  where id = p_library_id and owner_id = v_user_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count = 1;
end;
$$;

revoke all on function public.refora_sync_push(uuid, uuid, uuid, text, text, bigint, boolean, jsonb) from public, anon;
revoke all on function public.refora_sync_save_cursor(uuid, uuid, bigint) from public, anon;
revoke all on function public.refora_sync_register_library(uuid, text) from public, anon;
revoke all on function public.refora_sync_register_device(uuid, text) from public, anon;
revoke all on function public.refora_sync_list_libraries() from public, anon;
revoke all on function public.refora_sync_delete_library(uuid) from public, anon;

grant execute on function public.refora_sync_push(uuid, uuid, uuid, text, text, bigint, boolean, jsonb) to authenticated;
grant execute on function public.refora_sync_save_cursor(uuid, uuid, bigint) to authenticated;
grant execute on function public.refora_sync_register_library(uuid, text) to authenticated;
grant execute on function public.refora_sync_register_device(uuid, text) to authenticated;
grant execute on function public.refora_sync_list_libraries() to authenticated;
grant execute on function public.refora_sync_delete_library(uuid) to authenticated;
