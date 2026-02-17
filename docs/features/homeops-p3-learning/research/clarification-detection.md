# Research: Clarification Response Detection in Swedish

**Feature:** homeops-p3-learning (Phase 3)
**Question:** How to reliably detect affirmative vs corrective replies to bot clarification questions in Swedish for the alias learning system
**Date:** 2026-02-17

---

## Summary

Rule-based pattern matching is sufficient and recommended for detecting affirmative replies (Swedish has a finite, well-enumerated set of confirmation words). For corrective replies, a hybrid approach works best: rule-based negation detection to identify that a reply is corrective, then OpenAI extraction to identify the corrected activity and map it to a canonical form. The existing `reply_to_message` data in the Telegram webhook provides the structural signal needed to scope detection to actual clarification responses, and the `botMessageId` already stored in the activities table enables lookup of the original classification context.

---

## 1. Affirmative Patterns in Swedish

### 1a. Comprehensive Word List

Swedish has a well-defined set of affirmative expressions. These can be reliably detected with case-insensitive exact matching after trimming whitespace and punctuation.

**Tier 1 -- Unambiguous affirmatives (high confidence, safe for automated alias creation):**

| Word/Phrase | Notes |
|-------------|-------|
| `ja` | Standard "yes" |
| `jaa` / `jaaa` | Emphatic variants (1+ trailing 'a') |
| `japp` | Casual "yep" |
| `jepp` | Casual "yep" variant |
| `jo` | "Yes" in response to negation; also used as general affirmative in informal Swedish, especially northern dialects |
| `joo` | Emphatic `jo` |
| `ja visst` | "Yes certainly" |
| `javisst` | Compound form of above |
| `jajemen` | Emphatic "yes indeed" |
| `jajamenansen` | Very emphatic "yes indeed" (playful) |
| `precis` | "Exactly" |
| `exakt` | "Exactly" |
| `absolut` | "Absolutely" |
| `korrekt` | "Correct" |
| `det stammar` / `det stammer` | "That's correct" (with or without accents) |
| `stammar` / `stammer` | Short form of above |

**Tier 2 -- Informal/slang affirmatives (common in messaging, safe for alias creation):**

| Word/Phrase | Notes |
|-------------|-------|
| `aa` | Very informal "yes" |
| `a` | Ultra-short "yes" (single letter -- see edge case notes) |
| `mm` | Verbal nod |
| `mhm` | Verbal nod variant |
| `mmm` | Extended verbal nod |
| `mjo` | "Mm-yes" (slightly hesitant but still affirmative) |
| `okej` | "Okay" -- confirms understanding |
| `ok` | Short form |
| `jae` | Dialectal "yes" |
| `jadå` / `jada` | "Oh yes" / "sure" |
| `visst` | "Certainly" / "of course" |
| `sjalvklart` / `självklart` | "Of course" |
| `just det` | "That's right" |
| `sant` | "True" |

**Tier 3 -- Emoji-based affirmatives:**

| Emoji | Interpretation |
|-------|---------------|
| `👍` / `👍🏻`-`👍🏿` | Thumbs up (any skin tone) -- strong affirmative |
| `✅` | Checkmark -- strong affirmative |
| `✔️` / `☑️` | Alternative checkmarks |
| `👌` | OK hand -- affirmative |
| `🙂` / `😊` | Smile alone is ambiguous; treat as affirmative ONLY when it is the entire message |

**Linguistic note on `jo` vs `ja`:** In standard Swedish, `jo` is specifically used to affirm a negative statement (e.g., "Didn't you mean X?" -> "Jo"). Since the bot's clarification question is phrased as "Menade du [activity]?" (positive form), `ja` is the grammatically standard response. However, in informal messaging, `jo` is widely used interchangeably with `ja`, especially in northern Sweden. Both should be treated as affirmative.

### 1b. Matching Strategy

```
Normalize: lowercase, trim whitespace, strip trailing punctuation (. ! ? ,)
Match: exact match against word list OR regex for patterns with variable length (jaa+, mmm+)
```

Proposed regex for affirmative detection:

```
^(ja+|japp|jepp|jo+|ja\s*visst|javisst|jajemen|jajamenansen|precis|exakt|
absolut|korrekt|(det\s+)?st[aä]mm?er|aa+|mm+|mhm+|mjo|okej|ok|jae|
jad[aå]|visst|sj[aä]lvklart|just\s+det|sant|jadå)$
```

Emoji detection is separate: check if the message (after trimming) consists solely of one or more affirmative emoji characters.

### 1c. False Positive Risks

1. **Single-letter `a`**: Could be a typo or the start of an unfinished message. Mitigation: only accept `a` when it is the *entire* message text (after trim). Even then, it is low-risk because the detection only fires when the message is a direct reply to a bot clarification.

2. **`ok` / `okej`**: Could mean "I acknowledge your question" without necessarily confirming. In the context of a reply to "Menade du [activity]?", this is almost always affirmative. Accept it.

3. **Partial matches in longer messages**: "Ja, men jag menade egentligen..." (yes, but I actually meant...) starts with "ja" but is actually a correction. Mitigation: only match when the entire message (after normalization) matches the affirmative pattern. Messages with additional content are routed to corrective/ambiguous detection.

4. **`visst`**: Can mean "certainly" (affirmative) or "sure, I guess" (reluctant). In isolation as a reply to "Menade du X?", this is affirmative. Accept it.

### 1d. Reliability Assessment

**Rule-based matching for affirmatives is highly reliable.** The reason:
- The response space is constrained by the question format ("Menade du X?")
- Swedish affirmative words are a closed, finite set
- The structural signal (reply-to-bot-clarification) eliminates most false positive risk
- No semantic understanding is needed -- just lexical matching

Estimated accuracy: >98% for true affirmatives detected, <1% false positive rate. The main failure mode is missing an unusual affirmative expression, which is easily fixed by expanding the word list.

---

## 2. Corrective Patterns in Swedish

### 2a. Negation + Correction Patterns

Common corrective reply patterns to "Menade du [activity]?":

| Pattern | Example | Structure |
|---------|---------|-----------|
| `nej, [activity]` | "nej, tvätt" | negation + activity |
| `nej, jag menade [X]` | "nej, jag menade städning" | negation + explicit correction |
| `nej, det var [X]` | "nej, det var matlagning" | negation + clarification |
| `inte det, [X]` | "inte det, disk" | negation + activity |
| `inte det, utan [X]` | "inte det, utan tvätt" | negation + explicit alternative |
| `nä, [X]` | "nä, pantning" | casual negation + activity |
| `nää, [X]` | "nää, jag tvättade" | extended casual negation + activity |
| `nej jag [verb]` | "nej jag handlade" | negation + activity as verb |

### 2b. Simple Negation (No Correction Provided)

| Word | Notes |
|------|-------|
| `nej` | Standard "no" |
| `nä` | Casual "no" |
| `nää` / `näää` | Extended casual "no" |
| `nope` | English loan |
| `nah` | English loan |
| `inte` | "Not" -- usually part of a longer phrase |
| `nix` | Informal "no" |
| `nja` | "Well, not really" -- **ambiguous**, see edge cases |
| `👎` | Thumbs down emoji |
| `❌` | Cross mark emoji |

When the user provides only a negation without a correction, the system should:
1. Mark the original alias mapping as "rejected" (do NOT save it)
2. Not attempt to extract a corrected activity
3. Optionally respond: "Okej, tack!" (simple acknowledgment)

### 2c. Correction Without Explicit Negation

The user may skip the negation and just state the correct activity:

- "tvätt" (just the activity name)
- "jag tvättade" (I did laundry)
- "det var matlagning" (it was cooking)

This is the hardest case. A bare word like "tvätt" in reply to "Menade du städning?" could be:
1. A correction: the user means "no, I meant tvätt"
2. An unrelated message that happens to be a reply

**Recommendation:** When the reply is a direct reply to a bot clarification message AND the text does not match any affirmative pattern AND the text does not match any pure negation pattern, treat it as a **potential correction**. Route it to OpenAI for interpretation with the original clarification context.

### 2d. Correction Extraction Approach

For messages identified as corrective (either via negation detection or ambiguity routing), extract the corrected activity.

**Rule-based extraction is insufficient** for corrections because:
- The correction text is free-form Swedish
- Swedish compound words create ambiguity ("tvättmaskin" vs "tvätt" vs "tvättning")
- Verb forms need normalization ("tvättade" -> "tvätt", "städade" -> "städning")
- The correction might be embedded in a sentence

**OpenAI is recommended** for correction extraction. Send the reply text along with the original clarification context to the classifier, asking it to extract the canonical activity name. This reuses the existing classification infrastructure.

---

## 3. Edge Cases

### 3a. Delayed Replies

**Question:** If a user replies to the clarification message hours or even days later, should it still be processed?

**Recommendation:** Accept delayed replies with no time limit. Rationale:
- Telegram preserves the `reply_to_message` structure regardless of delay
- The structural signal (reply-to-bot-clarification) is unambiguous
- Household messaging is asynchronous -- people check group chats irregularly
- The alias mapping is equally valid whether confirmed immediately or later

Implementation note: The `reply_to_message` object in the Telegram webhook always contains the full original message, including its text. No DynamoDB lookup is needed to retrieve the clarification context.

### 3b. Non-Text Replies

| Reply Type | Handling |
|------------|----------|
| Text | Process normally |
| Sticker | Ignore -- too ambiguous to interpret (a "thumbs up" sticker might be affirmative, but sticker semantics vary wildly) |
| Photo / Video | Ignore -- not relevant to alias learning |
| Voice message | Ignore -- would require speech-to-text, out of scope |
| Document | Ignore |
| Reaction (emoji reaction) | **Important**: Telegram reactions are delivered as `message_reaction` updates, NOT as `message` updates. The current `allowed_updates: ["message"]` filter means the bot does NOT receive reactions. If reactions are desired, `allowed_updates` would need to include `"message_reaction"`. **Recommendation:** Skip for now; reactions are a Phase 4+ enhancement. |

The existing `isTextMessage` check in the ingest handler already filters out non-text messages. No additional logic is needed.

### 3c. Ambiguous Responses

| Response | Interpretation | Action |
|----------|---------------|--------|
| `kanske` | "Maybe" | Treat as non-actionable; do not create alias. Optionally re-ask. |
| `typ` | "Sort of" / "like" | Treat as non-actionable |
| `nja` | "Well..." (hesitant) | Treat as non-actionable |
| `typ det` | "Kind of" | Treat as non-actionable |
| `inte riktigt` | "Not exactly" | Treat as corrective, but no correction provided; do not create alias |
| `ja och nej` | "Yes and no" | Treat as non-actionable |
| `ungefär` | "Approximately" | Treat as weak affirmative -- could create alias but with lower confidence weight |

**Recommendation:** Define an "ambiguous" word list. If the entire message matches an ambiguous pattern, do NOT create an alias. Log the interaction for potential future analysis. Do not re-ask -- the user already provided a response; nagging is worse than losing one data point.

### 3d. Multiple Pending Clarifications

**Scenario:** The bot sends two clarification messages to the same user for two different original messages. The user replies to one.

**Non-issue in practice.** Each Telegram reply is tied to a specific `reply_to_message.message_id`. The bot can look up which clarification each reply references. The current Phase 2 implementation already stores `botMessageId` on each activity record (see `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts` lines 132-149), providing a direct lookup path.

**Detection flow:**
1. User replies to bot message -> `reply_to_message.message_id` identifies the specific bot message
2. Look up which activity has `botMessageId === reply_to_message.message_id` in the activities table
3. That activity's `activity` field tells us what was being clarified
4. Process the reply as affirmative/corrective for that specific activity

### 3e. Reply to Wrong Bot Message

**Scenario:** The user replies to a bot acknowledgment ("Noterat") instead of a clarification ("Menade du X?").

**Detection:** Check the text of `reply_to_message.text`. If it does not match the clarification pattern (`/^Menade du .+\?$/`), do not process as a clarification response. This reply should be treated as a regular message and classified normally.

### 3f. User Replies with Unrelated Message

**Scenario:** User replies to clarification with "Ska vi äta pizza ikväll?"

**Detection:** The message does not match any affirmative, negation, or ambiguous pattern. It contains no activity-like content in the correction position.

**Recommendation:** If the reply text does not match affirmative or negation patterns, send it to OpenAI with the clarification context. OpenAI can determine: (a) it is a correction, (b) it is unrelated. If unrelated, skip alias creation and process the message through the normal classification pipeline.

---

## 4. Detection Architecture

### 4a. Option A: Pure Rule-Based

```
Reply to bot clarification
  -> Is it a clarification message? (check reply_to_message.text matches "Menade du ...?")
  -> YES: Route to clarification handler
      -> Normalize text (lowercase, trim, strip punctuation)
      -> Match affirmative word list? -> CONFIRM alias
      -> Match negation word list?
          -> Contains text after negation? -> Extract text, create alias for correction (naive)
          -> No text after negation? -> REJECT (do not save alias)
      -> No match? -> REJECT (do not save alias, classify as normal message)
```

**Pros:** Zero cost, zero latency, no OpenAI dependency.
**Cons:** Cannot reliably extract corrected activity from free-form corrections. Cannot handle ambiguous corrections. Naive text extraction after negation will fail on Swedish compound words and verb forms.

### 4b. Option B: Pure OpenAI

```
Reply to bot clarification
  -> Is it a clarification message?
  -> YES: Send to OpenAI with prompt:
      "Original clarification: 'Menade du {activity}?'
       User reply: '{reply_text}'
       Classify as: affirmative / corrective / unrelated
       If corrective, extract the canonical activity name."
  -> Process OpenAI result
```

**Pros:** Handles all edge cases, including ambiguous corrections and Swedish morphology. Can map corrections to canonical activity names.
**Cons:** Every clarification response costs ~$0.00015 and adds 300-800ms latency. At low volume (maybe 1-3 clarification responses per day), this is negligible. But it adds an unnecessary API call for the 80%+ of responses that are simple "ja" or "nej".

### 4c. Option C: Hybrid (Recommended)

```
Reply to bot clarification
  -> Is it a clarification message? (regex on reply_to_message.text)
  -> YES: Route to clarification handler
      -> Normalize text
      -> Match affirmative pattern? -> CONFIRM alias (no OpenAI call)
      -> Match pure negation pattern (no additional text)? -> REJECT alias (no OpenAI call)
      -> Match ambiguous pattern? -> SKIP (no alias, no OpenAI call)
      -> Anything else? -> Send to OpenAI for interpretation
          -> OpenAI returns: { intent: "corrective" | "unrelated", activity?: string }
          -> If corrective + activity: Create alias for corrected activity
          -> If unrelated: Process through normal classification
```

**Pros:**
- Zero cost for the majority of responses (simple ja/nej)
- OpenAI handles the genuinely hard cases (free-form corrections, compound words, verb normalization)
- Graceful handling of unrelated replies
- Reuses existing OpenAI infrastructure and billing

**Cons:**
- Two code paths (rule-based + OpenAI)
- More complex than pure rule-based
- OpenAI still needed for corrections (but corrections are the minority case)

### 4d. Cost and Latency Analysis

| Approach | Cost/month | Avg Latency | Accuracy |
|----------|-----------|-------------|----------|
| Rule-based only | $0 | <1ms | ~90% (poor on corrections) |
| OpenAI only | ~$0.045 (10 responses/day) | 300-800ms | ~98% |
| Hybrid | ~$0.009 (2 OpenAI calls/day) | <1ms (80%), 300-800ms (20%) | ~97% |

Assumptions: 10 clarification responses per day, 80% are simple affirmatives/negations, 20% need OpenAI.

At this volume, all three options are financially negligible. The decision should be driven by accuracy and complexity, not cost.

---

## 5. Correction Activity Extraction

### 5a. Extraction via OpenAI

When a reply is identified as corrective (either by rule-based negation detection with additional text, or by the hybrid path), send it to OpenAI for canonical activity extraction.

**Proposed prompt for correction extraction:**

```
The bot asked a Swedish household member: "Menade du {originalActivity}?"
The user replied: "{replyText}"

Determine:
1. Is this reply affirming the suggestion, correcting it, or unrelated?
2. If correcting, what canonical Swedish household activity did the user mean?

Respond with:
- intent: "affirmative" | "corrective" | "negative" | "unrelated"
- activity: canonical activity name in Swedish (only if corrective)
```

This can use the same `gpt-4o-mini` model and structured output pattern already in use for classification.

**Schema (Zod):**

```typescript
const ClarificationResponseSchema = z.object({
  intent: z.enum(["affirmative", "corrective", "negative", "unrelated"]),
  activity: z.string().describe("Canonical activity name if corrective, empty string otherwise"),
});
```

### 5b. Canonical Activity Mapping

The corrected activity should be mapped to a canonical form. This is best done by OpenAI in the same call -- include the list of known canonical activities in the prompt so the model maps "tvättade" to "tvätt", "dammsög" to "dammsugning", etc.

**Alternatively**, the correction text can be run through the existing `classifyMessage` function. If the user says "nej, jag tvättade", classifying "jag tvättade" would produce `{ type: "chore", activity: "tvätt" }`. This reuses the existing classification pipeline without a new prompt.

**Recommendation:** Use the existing classifier for correction extraction. Send the corrective text (with negation prefix stripped) through `classifyMessage`. If it classifies as a chore or recovery activity, use that activity as the canonical mapping. This approach:
- Reuses existing code
- Maintains consistency with how activities are named
- Requires no new prompt engineering
- Already handles Swedish morphology and compound words

### 5c. Ambiguous Corrections

| Scenario | Handling |
|----------|----------|
| "nej, städning" | Clear -- extract "städning" |
| "nej, jag dammsög" | Verb form -- classifier normalizes to "dammsugning" |
| "nej, fixade lite i hemmet" | Vague -- classifier may produce low confidence; do not create alias if confidence < 0.70 |
| "nej, nånting annat" | No specific activity -- do not create alias |
| "nej nej nej" | Multiple negations, no activity -- do not create alias |

**Rule:** Only create an alias from a correction if the classifier returns a non-"none" type with confidence >= 0.70.

---

## 6. Swedish Linguistic Nuances

### 6a. Informal Writing Conventions in Messaging

Swedish messaging culture has several patterns relevant to detection:

1. **Vowel extension for emphasis:** "jaa", "jaaa", "neej", "nääää" -- all mean the same as the base word, just more emphatic. Detection regex should allow 1+ repeated vowels.

2. **Case insensitivity:** Swedish messaging is almost universally lowercase. Case should be normalized before matching.

3. **No punctuation:** Messages rarely include punctuation in casual messaging. The normalizer should strip trailing punctuation.

4. **Mixed Swedish/English:** Young Swedes frequently mix English words. "Nope", "yep", "yess", "ok" are all common.

5. **"Nä"-family nuances:** The word "nä" has many extended forms with subtly different meanings in spoken Swedish. In writing:
   - `nä` = simple no
   - `nää` = emphatic no
   - `nähä` = "really?!" (surprise, not necessarily negation) -- **do not treat as negation**
   - `nämen` = "well well" / "fancy that" -- **not a negation**

   For detection, only `nä`, `nää`, `nääå` (with trailing vowel extensions), `nej`, `nix`, and `nope` should be treated as negations.

### 6b. Compound Words

Swedish aggressively creates compound nouns. This affects both alias matching and activity extraction:

| Root | Compound Variants |
|------|-------------------|
| disk | diskning, diskmaskinen, diskbänken, diskmedel |
| tvätt | tvättning, tvättmaskin, tvättstuga |
| städ | städning, storstädning, städare |
| damm | dammsugning, dammsugare, dammtorka |
| mat | matlagning, mathandling, mataffären |
| hand | handla, handling, handlade |

For alias creation, store the **root form** or the **canonical activity name** as returned by the classifier. The alias itself (the key) should be the original text that was unclear. Example:

- User said: "pantade" -> Bot asked: "Menade du pantning?" -> User confirms "ja"
- Alias: `pantade` -> `pantning` (the canonical name from the classifier)

### 6c. Verb Form Normalization

Swedish verbs in past tense are commonly used when reporting activities:

| Infinitive | Past tense | Imperative | Noun form |
|------------|-----------|------------|-----------|
| städa | städade | städa | städning |
| tvätta | tvättade | tvätta | tvätt |
| diska | diskade | diska | disk/diskning |
| dammsuga | dammsög | dammsug | dammsugning |
| handla | handlade | handla | handling |
| laga (mat) | lagade | laga | matlagning |

The classifier already handles these verb forms (see the system prompt in `/Users/martinnordlund/homeOps/src/shared/services/classifier.ts` lines 33-40). Reusing the classifier for correction extraction means verb normalization is handled automatically.

---

## 7. Implementation Details

### 7a. Clarification Detection in the Worker Pipeline

The current worker handler (see `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts`) processes messages sequentially. The clarification response detection should be added **before** the classification step, because a clarification response should not be re-classified as a new activity.

**Proposed flow:**

```
Worker receives SQS message
  -> Parse body (MessageBody already includes replyToMessageId, replyToIsBot)
  -> Store raw message in messages table (existing)
  -> NEW: Is this a reply to a bot clarification?
      -> Check: replyToIsBot === true
      -> Check: Look up the bot message to determine if it was a clarification
      -> If yes: Process as clarification response (affirmative/corrective/unrelated)
      -> If clarification response handled: SKIP normal classification pipeline
  -> Existing: Classify message, store activity, evaluate response policy, send response
```

### 7b. Looking Up the Original Clarification

When a user replies to a bot message, the `MessageBody` contains `replyToMessageId` (the bot's message ID) and `replyToIsBot: true`. To determine if the bot message was a clarification:

**Option 1: Check `reply_to_message.text` from the Telegram payload.**

The ingest handler currently extracts `replyToMessageId` and `replyToIsBot` from the Telegram update but does NOT extract `reply_to_message.text`. This field needs to be added to the SQS message body.

```typescript
// In ingest handler, add:
if (message.reply_to_message) {
  messageBody.replyToMessageId = message.reply_to_message.message_id;
  messageBody.replyToIsBot = message.reply_to_message.from?.is_bot ?? false;
  messageBody.replyToText = message.reply_to_message.text; // NEW
}
```

Then in the worker, check if `replyToText` matches the pattern `/^Menade du .+\?$/`.

**Option 2: Query the activities table by `botMessageId`.**

The worker already stores `botMessageId` on activity records. Query the activities table to find the activity whose `botMessageId` matches `replyToMessageId`. If found, the activity's `activity` field tells us what was being clarified.

**Recommendation:** Use Option 1 (pass `replyToText` via SQS) as the primary check, with Option 2 as a fallback for extracting the original activity context. Option 1 is simpler and avoids a DynamoDB read. The `reply_to_message.text` is always available in the Telegram webhook payload, even for old messages.

But crucially, we also need the original classification context (what activity was suggested) to create the alias mapping. For this, extract the activity name from the bot's message text: `/^Menade du (.+)\?$/` captures the activity name.

### 7c. MessageBody Extension

Add to the `MessageBody` interface in `/Users/martinnordlund/homeOps/src/shared/types/classification.ts`:

```typescript
export interface MessageBody {
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToIsBot?: boolean;
  replyToText?: string;  // NEW: text of the replied-to message
}
```

### 7d. Activities Table Query for Clarification Context

When a clarification response is detected, we need the original activity's classification context. The `botMessageId` stored on activity records enables this lookup.

However, the activities table uses `chatId` as PK and `activityId` (ULID) as SK. There is no GSI on `botMessageId`. To look up by `botMessageId`, we would need either:

1. **A new GSI** on `botMessageId` -- adds infrastructure cost and complexity for a rare query pattern
2. **A scan with filter** -- inefficient but the table is small at household scale
3. **Extract from bot message text** -- the clarification message "Menade du X?" already contains the activity name

**Recommendation:** Extract the activity name from the bot's clarification text using regex. This avoids any DynamoDB lookup entirely:

```typescript
const match = replyToText.match(/^Menade du (.+)\?$/);
if (match) {
  const suggestedActivity = match[1]; // e.g., "tvätt"
  // Now we know the bot suggested "tvätt" and the user is responding
}
```

---

## 8. Practical Recommendations

### 8a. Recommended Detection Approach: Hybrid (Option C)

Use rule-based detection for the common cases (affirmative and simple negation), and OpenAI for everything else. The decision tree:

```
Is reply_to_message a bot clarification? (regex on text)
  |
  NO -> Process as normal message (existing pipeline)
  |
  YES -> Normalize reply text
         |
         +-> Matches affirmative pattern? -> Create alias (originalText -> suggestedActivity)
         |
         +-> Matches pure negation (no additional text)? -> Reject (do not create alias)
         |
         +-> Matches ambiguous pattern? -> Skip (do not create alias, do not re-classify)
         |
         +-> Anything else? -> Send corrective text through classifyMessage
             |
             +-> Returns activity with confidence >= 0.70? -> Create alias (originalText -> correctedActivity)
             |
             +-> Returns "none" or low confidence? -> Skip (do not create alias)
```

### 8b. Confidence Thresholds for Alias Creation

| Scenario | Required Confidence | Confirmations for "Reliable" |
|----------|-------------------|------------------------------|
| Affirmative (user confirms bot suggestion) | N/A (binary) | 1 confirmation creates alias; 3+ makes it "reliable" |
| Corrective (user provides different activity) | Classifier confidence >= 0.70 on the correction | 1 correction creates alias; 2+ makes it "reliable" |
| Contradictory data (same alias maps to different activities) | Highest-confirmation mapping wins | Explicit correction always overrides |

**Rationale for confirmation counts:**
- 1 confirmation is enough to create an alias because the user explicitly responded to a direct question. This is high-signal data.
- 3+ confirmations mark the alias as "reliable" -- meaning it can be used with higher weight in classification prompts.
- The `confirmations` counter on the alias record (see PRD DynamoDB design, `ALIAS#<chatId>` records) tracks this automatically.

### 8c. Handling Detection Uncertainty

When the system cannot confidently classify a reply as affirmative, corrective, or unrelated:

1. **Do not create an alias** -- precision over recall
2. **Do not re-ask** -- this creates conversational friction
3. **Process the reply as a normal message** -- it enters the standard classification pipeline
4. **Log the uncertain interaction** -- useful for future word list expansion

### 8d. What the Original Text for Alias Mapping Should Be

The alias maps an "original text" to a "canonical activity." The original text should be the text from the *original user message* that triggered the medium-confidence classification, not the reply text.

However, the original message text is not directly available in the clarification response flow. The SQS message contains only the reply, not the original message. Options:

1. **Store the original message text on the activity record** -- it is already stored in the raw messages table (`text` field). The activity record has `messageId` which can be used to look it up.
2. **Use the `suggestedActivity` from the bot's clarification text** -- the bot said "Menade du tvätt?", so `tvätt` was the suggested mapping. If the user confirms, the alias maps the original user's phrasing to `tvätt`.
3. **For the alias key, use a normalized version of the original message** -- but this is a full sentence, not a single word. Aliases should map short terms, not full sentences.

**Recommendation:** The alias system should map *the activity term from the original classification* to the *confirmed canonical activity*. If the classifier produced `activity: "pant"` with medium confidence and the bot asked "Menade du pant?", and the user confirmed, the alias maps `pant` -> `pantning` (or whatever the canonical form is). The alias key is the classifier's output activity name that was ambiguous, not the full message text.

Wait -- this does not match the PRD's intent. The PRD says the alias should map the *original word/phrase* from the user's message to the confirmed activity. For example, if the user said "pantade idag" and the classifier was unsure, the alias should map "pantade" (the specific word) to the canonical activity.

**Revised recommendation:** For Phase 3 initial implementation, use the classifier's `activity` field as the alias key (e.g., `pant` -> canonical `pantning`). This is simpler and covers the most common case. The full message text can be stored as metadata for future analysis. Extracting the specific ambiguous word from the original message would require NLP parsing that adds complexity without much benefit at this stage.

---

## Recommendation

**Use the Hybrid approach (Option C) for clarification response detection:**

1. **Rule-based** for affirmatives (word list match) and simple negations (negation word list match). This handles ~80% of cases with zero cost and <1ms latency.

2. **Existing classifier** for corrections. Strip the negation prefix from corrective replies and run the remainder through `classifyMessage`. This reuses infrastructure, handles Swedish morphology, and maintains naming consistency.

3. **Extend the ingest handler** to pass `replyToText` in the SQS message body so the worker can check if the reply targets a clarification message.

4. **Extract the suggested activity from the bot's clarification text** using regex (`/^Menade du (.+)\?$/`) to avoid DynamoDB lookups.

5. **Store aliases with a `confirmations` counter** starting at 1. Increment on subsequent confirmations of the same mapping. Consider an alias "reliable" at 3+ confirmations.

6. **Never re-ask or nag.** If detection is uncertain, skip alias creation and process the message through the normal pipeline.

---

## Trade-offs

| Decision | What We Gain | What We Give Up |
|----------|-------------|-----------------|
| Rule-based for affirmatives | Zero cost, zero latency, simple code | Must maintain word list manually; may miss novel affirmatives |
| OpenAI for corrections only | Handles Swedish morphology, compound words, verb forms | 300-800ms latency for correction responses; ~$0.009/month |
| Extract activity from bot text (not DynamoDB) | No extra read, simpler code | If bot message format changes, regex breaks (mitigated by using a constant for the format) |
| Single confirmation creates alias | Fast learning, immediate improvement | Risk of creating aliases from misunderstood interactions (mitigated by the confirmation count and the override system) |
| Classifier-based activity name as alias key | Simple, consistent with existing naming | Does not capture the exact user phrasing that was ambiguous |
| Skip uncertain interactions | Precision over recall, no annoying re-asks | Lose some learning opportunities |
| Ignore non-text replies | Simpler implementation | Miss sticker/reaction-based confirmations (rare and hard to interpret) |

---

## Open Questions

1. **Should the alias key be the classifier's activity name or the original user's exact phrasing?** The classifier's activity name is simpler and more consistent, but the original phrasing captures the actual vocabulary the user uses. This affects how aliases are matched at classification time. If the alias key is "pant" (from the classifier), it only helps when the classifier already partially recognizes the word. If the alias key is "pantade" (from the user's message), it helps with exact re-occurrences of that word form.

2. **How should the system handle the case where a user's correction maps to a DIFFERENT activity type than the original?** Example: Bot asks "Menade du [chore]?" and user says "nej, jag vilade" (a recovery activity, not a chore). The alias should still be created, but it crosses type boundaries. Is this expected behavior?

3. **Should reaction-based responses (Telegram message reactions like thumbs up) be supported in Phase 3 or deferred?** Supporting reactions would require adding `"message_reaction"` to `allowed_updates` in the webhook configuration, which changes the ingest handler contract. This could be a Phase 4+ enhancement.

4. **What happens when a user confirms a clarification but the original message has already been re-processed?** For example, if SQS retried the original message and it was classified differently on the second attempt. The `botMessageId` on the activity record provides a link, but there could be duplicate activity records for the same original message.

5. **Should the existing `CONFIDENCE_CLARIFY` threshold (0.50) be raised now that alias learning provides a feedback mechanism?** With aliases improving future classifications, the system could afford to clarify more aggressively (e.g., 0.40-0.84), knowing that each clarification is also a learning opportunity. However, this risks annoying users with too many questions.
