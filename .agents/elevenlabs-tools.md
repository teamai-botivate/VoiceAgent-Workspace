# ElevenLabs Tool Configuration

These tools connect the existing ElevenLabs agent to this standalone service. Replace
`<PUBLIC_BASE_URL>` with the HTTPS tunnel URL. Every tool must include:

```text
X-Agent-Tool-Secret: <AGENT_TOOL_SECRET>
Content-Type: application/json
```

Never place the Turso token, Groq key, ElevenLabs key, or internal API token in a tool.

## Shared dynamic variables

Outbound call initiation supplies:

- `tenant_id`
- `followup_id`
- `call_session_id`
- `tenant_name`
- `supplier_name`
- `contact_name`
- `requirement_number`
- `preferred_language`

Use the first three identifiers in every tool call.

## 1. get_followup_context

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/followup-context`
- Use: Call once near the start, before stating requirement data.

```json
{
  "tenantId": "{{tenant_id}}",
  "followupId": "{{followup_id}}",
  "callSessionId": "{{call_session_id}}"
}
```

## 2. get_business_answer

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/business-answer`
- Use: Answer a vendor question in one approved category.

Additional parameter:

```json
{
  "questionCategory": "delivery_location | payment_terms | gst_policy | quotation_validity | commercial_unit"
}
```

## 3. record_pricing_outcome

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/pricing-outcome`
- Use: Only after the vendor explicitly confirms the complete final pricing.

```json
{
  "tenantId": "{{tenant_id}}",
  "followupId": "{{followup_id}}",
  "callSessionId": "{{call_session_id}}",
  "requirementId": "requirement id returned by get_followup_context",
  "requirementVersion": 1,
  "explicitConfirmation": true,
  "discountBasisPoints": 500,
  "items": [
    {
      "requirementItemId": "item id returned by get_followup_context",
      "initialRateMinor": 30000,
      "revisedRateMinor": 28500,
      "finalRateMinor": 28500,
      "unit": "KG"
    }
  ]
}
```

Rates are integer paise per KG: INR 300.00 is `30000`. The array must contain every
requirement item exactly once.

## 4. schedule_callback

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/schedule-callback`

Additional parameters:

```json
{
  "callbackAt": "ISO-8601 timestamp with offset",
  "reason": "Vendor-provided callback reason"
}
```

## 5. record_supplier_response

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/supplier-response`

Allowed dispositions:

- `quotation_will_be_sent`
- `cannot_supply`
- `not_interested`
- `wrong_contact`
- `requirement_not_received`
- `needs_more_information`

Additional parameter: `summary`, limited to factual vendor-provided information.

## 6. finalize_call

- Method: `POST`
- URL: `<PUBLIC_BASE_URL>/agent-tools/finalize-call`

Allowed dispositions:

- `pricing_confirmed`
- `callback_requested`
- `quotation_pending`
- `cannot_supply`
- `not_interested`
- `wrong_contact`
- `no_answer`
- `failed`

`pricing_confirmed` is rejected unless `record_pricing_outcome` already committed a
confirmed quotation.
