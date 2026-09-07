from __future__ import annotations

import math
import re
from typing import Any

from refora_server.agent.application_catalog import (
    APPLICATION_ACTIONS, APPLICATION_GAPS, APPLICATION_OPERATIONS,
    public_tool_reference, resolve_application_call,
)
from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.tools.common import object_schema


class ApplicationInputError(ValueError):
    code = 'invalid_tool_arguments'

    def __init__(self, message: str, *, tool: str, action: str | None = None, schema: dict | None = None):
        super().__init__(message)
        self.details = {'tool': tool, 'action': action, 'nextCall': {'action': 'help', 'parameters': {'action': action} if action else {}}}
        if schema is not None:
            self.details['parametersSchema'] = public_schema(schema)


def action_schema(actions: tuple[str, ...] | list[str]) -> dict[str, Any]:
    return object_schema({
        'action': {'type': 'string', 'enum': ['help', *actions], 'description': 'Choose one action. help returns its exact parameters schema.'},
        'parameters': {'type': 'object', 'description': 'Arguments for the selected action. For help, use {} for the catalog, {"action":"..."} for one schema, or {"coverage":true} for known capability gaps.', 'additionalProperties': True},
    }, ['action'])


def tool_description(name: str) -> str:
    domain = 'local PDF library and categories' if name == 'refora_library' else 'workspaces, cards, connections, notes, reports and attachments'
    example = '{"action":"star","parameters":{"docIds":["id"],"starred":true}}' if name == 'refora_library' else '{"action":"cards.layout","parameters":{"workspaceId":"id","items":[{"itemId":"id","x":100,"width":500}]}}'
    return f'Manage Refora {domain}. Use action + parameters; example: {example}. Call help to discover actions and their exact required fields before unfamiliar operations. Omitted workspaceId uses the current workspace. Ordinary changes run immediately; deletion requires application approval for this exact action and arguments. help with coverage=true lists verified gaps; do not claim full application control.'


def _public_text(text: str) -> str:
    return re.sub(r'\b(?:' + '|'.join(re.escape(name) for name in sorted(APPLICATION_OPERATIONS, key=len, reverse=True)) + r')\b', lambda match: public_tool_reference(match[0]), text)


def public_schema(schema: Any) -> Any:
    if isinstance(schema, list):
        return [public_schema(item) for item in schema]
    if isinstance(schema, dict):
        return {key: _public_text(item) if key == 'description' and isinstance(item, str) else public_schema(item) for key, item in schema.items()}
    return schema


def public_result(result: Any) -> Any:
    if isinstance(result, list):
        return [public_result(item) for item in result]
    if not isinstance(result, dict):
        return result
    result = dict(result)
    next_tool = result.get('nextTool')
    if isinstance(next_tool, str) and next_tool in APPLICATION_OPERATIONS:
        result['nextTool'], result['nextAction'] = APPLICATION_OPERATIONS[next_tool]
    for key in ('instruction', 'message'):
        if isinstance(result.get(key), str):
            result[key] = _public_text(result[key])
    return result


def help_result(name: str, parameters: dict[str, Any], registry: dict, allowed: tuple[str, ...]) -> dict[str, Any]:
    if set(parameters) - {'action', 'coverage'} or ('coverage' in parameters and type(parameters['coverage']) is not bool):
        raise ApplicationInputError('help accepts optional action and coverage only', tool=name)
    selected = parameters.get('action')
    if selected is not None and (not isinstance(selected, str) or selected not in allowed):
        raise ApplicationInputError('The requested help action is unavailable', tool=name)
    result = {'tool': name, 'actions': []}
    for action in ([selected] if selected is not None else allowed):
        operation = APPLICATION_ACTIONS[name][action]
        _, schema, description = registry[operation]
        risk = classify(operation)
        entry = {'action': action, 'description': _public_text(description), 'readOnly': risk in {RiskClass.READ, RiskClass.NETWORK_READ}, 'requiresApproval': risk is RiskClass.DESTRUCTIVE}
        if selected is not None:
            entry['parametersSchema'] = public_schema(schema)
        result['actions'].append(entry)
    if parameters.get('coverage') is True:
        result['coverage'] = APPLICATION_GAPS[name]
    return result


def validate_parameters(value: Any, schema: dict[str, Any], root: dict | None = None, path: str = 'parameters') -> None:
    root = root or schema
    if '$ref' in schema:
        target = root
        for part in schema['$ref'].removeprefix('#/').split('/'):
            target = target[part]
        return validate_parameters(value, target, root, path)
    if 'anyOf' in schema:
        for option in schema['anyOf']:
            try:
                validate_parameters(value, option, root, path)
                break
            except ValueError:
                pass
        else:
            raise ValueError(f'{path} does not match any allowed shape')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f'{path} must be one of {schema["enum"]}')
    expected = schema.get('type')
    valid = {
        'object': isinstance(value, dict), 'array': isinstance(value, list),
        'string': isinstance(value, str), 'boolean': type(value) is bool,
        'integer': type(value) is int, 'number': type(value) in (int, float), 'null': value is None,
    }
    if expected is not None and not valid.get(expected, False):
        raise ValueError(f'{path} must be {expected}')
    if isinstance(value, dict):
        missing = set(schema.get('required', [])) - value.keys()
        if missing:
            raise ValueError(f'{path} missing required fields: {", ".join(sorted(missing))}')
        properties = schema.get('properties', {})
        unknown = value.keys() - properties.keys()
        if unknown and schema.get('additionalProperties') is False:
            raise ValueError(f'{path} has unsupported fields: {", ".join(sorted(unknown))}')
        for key, item in value.items():
            if key in properties:
                validate_parameters(item, properties[key], root, f'{path}.{key}')
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0) or len(value) > schema.get('maxItems', math.inf):
            raise ValueError(f'{path} has an invalid number of entries')
        for index, item in enumerate(value):
            validate_parameters(item, schema.get('items', {}), root, f'{path}[{index}]')
    if isinstance(value, str) and (len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', math.inf)):
        raise ValueError(f'{path} has an invalid length')
    if type(value) in (int, float):
        if not math.isfinite(value) or value < schema.get('minimum', -math.inf) or value > schema.get('maximum', math.inf) or value <= schema.get('exclusiveMinimum', -math.inf) or value >= schema.get('exclusiveMaximum', math.inf):
            raise ValueError(f'{path} is outside its allowed range')


def dispatch_application(executor: Any, name: str, arguments: dict, registry: dict, allowed: tuple[str, ...] | None = None) -> Any:
    allowed = tuple(APPLICATION_ACTIONS[name]) if allowed is None else allowed
    try:
        operation, parameters = resolve_application_call(name, arguments)
    except ValueError as error:
        raise ApplicationInputError(str(error), tool=name) from error
    if operation == '__application_help':
        return help_result(name, parameters, registry, allowed)
    action = arguments['action']
    if action not in allowed:
        raise ApplicationInputError('Action is not available in this tool context', tool=name)
    handler, schema, _ = registry[operation]
    try:
        validate_parameters(parameters, schema)
    except ValueError as error:
        raise ApplicationInputError(str(error), tool=name, action=action, schema=schema) from error
    return public_result(handler(executor, parameters))
