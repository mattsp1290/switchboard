import json
import sys
from importlib.metadata import version

from pydantic import TypeAdapter, ValidationError
from ag_ui._generated import models
import ag_ui.core as public
from ag_ui.core import PROTOCOL_VERSION

request = json.load(sys.stdin)
fields = {}
for name in request['definitions']:
    model = getattr(models, name)
    if hasattr(public, name):
        assert getattr(public, name) is model, name
    if hasattr(model, 'model_fields'):
        fields[name] = {
            'fields': sorted(field.alias for field in model.model_fields.values()),
            'required': sorted(field.alias for field in model.model_fields.values() if field.is_required()),
        }
accepted = []
for case in request['cases']:
    try:
        TypeAdapter(getattr(models, case['definition'])).validate_python(case['value'])
        accepted.append(True)
    except ValidationError:
        accepted.append(False)
print(json.dumps({
    'version': version('ag-ui-protocol'),
    'protocol': PROTOCOL_VERSION,
    'events': [event.value for event in models.EventType],
    'fields': fields,
    'public': {name: hasattr(public, name) for name in request['definitions']},
    'accepted': accepted,
}))
