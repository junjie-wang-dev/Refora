alter function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) rename to refora_sync_push_v4_internal;

revoke all on function public.refora_sync_push_v4_internal(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) from public, anon, authenticated;

create function public.refora_sync_push(
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
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  perform public.refora_sync_push_v4_internal(
    p_library_id,
    p_device_id,
    p_operation_id,
    p_entity_type,
    p_entity_id,
    p_base_version,
    p_deleted,
    p_payload
  );

  select result into v_result
  from refora_sync.operations
  where user_id = v_user_id and operation_id = p_operation_id;

  if v_result is null then
    raise exception 'Sync operation result is missing' using errcode = '55000';
  end if;

  return v_result;
end;
$$;

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
