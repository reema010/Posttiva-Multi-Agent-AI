# ═══════════════════════════════════════════════════════════════════
#  agents/text_agent.py
#  Text Agent — IDENTICAL logic from Colab notebook Cell 10
#
#  Changes from Colab (wrapper only — zero logic changes):
#    • Removed google.colab imports
#    • API keys come from environment variables
#    • input() prompts replaced by settings dict from API request
#    • print() statements kept — they appear in RunPod logs
# ═══════════════════════════════════════════════════════════════════

import os, json, time, base64
from typing import Dict, Callable, Optional


def run_text_agent(
    image_path: str,
    settings: dict,
    on_progress: Optional[Callable[[str], None]] = None,
) -> dict:
    """
    Runs the full Text Agent pipeline.
    Returns { headline, description, cta }
    """

    def _prog(msg):
        if on_progress:
            on_progress(msg)
        print(msg)

    # ── API clients — keys from environment ──────────────────────
    import anthropic as _ant
    import openai   as _oai_lib

    TEXT_AGENT_ANTHROPIC_KEY = os.environ.get("TEXT_AGENT_ANTHROPIC_KEY", "")
    OPENAI_API_KEY           = os.environ.get("OPENAI_API_KEY", "")

    anthropic_client = _ant.Anthropic(api_key=TEXT_AGENT_ANTHROPIC_KEY)
    openai_client    = _oai_lib.OpenAI(api_key=OPENAI_API_KEY)

    # ── Settings from API payload ─────────────────────────────────
    ad_type       = settings.get("ad_type",       "Product ad")
    product_focus = settings.get("product_focus", "Aesthetic")
    discount      = settings.get("discount",      0)
    room          = settings.get("room",          "Living Room")
    room_style    = settings.get("room_style",    "Modern")
    lighting      = settings.get("lighting",      "Sunlight")
    urgency       = settings.get("urgency",       "Non-urgent")

    # ════════════════════════════════════════════════════════════════
    # Tool Functions — IDENTICAL to Colab notebook
    # ════════════════════════════════════════════════════════════════

    def extract_attributes(image_path: str) -> Dict:
        """
        Tool 1: Extract furniture attributes from image using Vision AI

        This function analyzes a furniture image and extracts:
        - Type (sofa, chair, table, etc.)
        - Material (fabric, boucle, leather, etc.)
        - Color (specific color description)
        - Style (modern, classic, vintage, etc.)

        Args:
            image_path: Path to the furniture image file

        Returns:
            Dictionary with extracted attributes
        """
        print("\n🔍 [TOOL] Extracting attributes from image...")

        # Read image and convert to base64 for API
        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        # Call GPT-4o-mini Vision API
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": """Analyze this furniture image carefully:

Type: [sofa/chair/table/bed/cabinet/desk/dining table - if identifiable]
Material: [fabric/boucle/velvet/leather/wood/metal - be specific]
Color: [specific color like light beige, cream, dark gray]
Style: [modern/vintage/curved/minimalist/classic]

IMPORTANT: Only provide confident answers. If unsure, write "N/A"

Format:
Type: [answer or N/A]
Material: [answer or N/A]
Color: [answer or N/A]
Style: [answer or N/A]"""
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}
                    }
                ]
            }],
            max_tokens=120,
            temperature=0.1  # Low temperature for consistent attribute extraction
        )

        # Parse the response text into a dictionary
        attrs = {}
        text = response.choices[0].message.content

        for line in text.split('\n'):
            line = line.strip()
            if ':' in line and len(line) > 3:
                parts = line.split(':', 1)
                if len(parts) == 2:
                    key = parts[0].strip().lower()
                    val = parts[1].strip()
                    attrs[key] = val if val else 'N/A'

        # Ensure all required keys exist
        for key in ['type', 'material', 'color', 'style']:
            if key not in attrs:
                attrs[key] = 'N/A'

        print(f"✅ Extracted: {attrs}")
        return attrs


    def generate_marketing_text(
        attributes: Dict,
        ad_type: str,
        product_focus: str,
        discount: int,
        room: str,
        room_style: str,
        lighting: str,
        urgency: str
    ) -> Dict:
        """
        Tool 2: Generate marketing poster text based on attributes and campaign settings

        Creates professional marketing copy with:
        - Headline (3-6 words)
        - Description (8-12 words)
        - Call-to-Action/CTA (2 words max)

        Args:
            attributes: Furniture attributes from extract_attributes()
            ad_type: Type of advertisement (Product ad/Offers/Eid/National Day)
            product_focus: Marketing focus (Aesthetic/Comfort/Practical)
            discount: Discount percentage (0-100)
            room: Room setting (Living Room/Bedroom)
            room_style: Room style (Modern/Classic/Boho)
            lighting: Lighting type (Sunlight/Indoor Lighting)
            urgency: Urgency level (Non-urgent/Urgent)

        Returns:
            Dictionary with generated text {headline, description, cta}
        """
        print(f"\n✍️  [TOOL] Generating {ad_type} text (Focus: {product_focus})...")

        # Build product description with TYPE
        furniture_type = ""
        product_brief = ""

        # Get furniture type
        if attributes.get('type') and attributes.get('type') != 'N/A':
            furniture_type = attributes.get('type')

        # Get material
        if attributes.get('material') and attributes.get('material') != 'N/A':
            product_brief = attributes.get('material')

        # Get color
        if attributes.get('color') and attributes.get('color') != 'N/A':
            if product_brief:
                product_brief = f"{attributes.get('color')} {product_brief}"
            else:
                product_brief = attributes.get('color')

        # Full description
        if furniture_type:
            if product_brief:
                full_product = f"{product_brief} {furniture_type}"
            else:
                full_product = furniture_type
        else:
            full_product = product_brief if product_brief else "premium furniture"

        # Select appropriate prompt based on ad type
        if ad_type == "Product ad":
            # Product advertisement prompts - focus on product benefits
            focus_data = {
                "Aesthetic": {
                    "emotion": "beauty, elegance, style transformation",
                    "examples": [
                        f"Modern {furniture_type} transforms your space with elegance",
                        f"Elegant {furniture_type} design elevates any room beautifully",
                        f"Stunning {furniture_type} brings contemporary style to life"
                    ] if furniture_type else [
                        "Elegant curves meet modern sophistication",
                        "Sculptural design transforms any space"
                    ]
                },
                "Comfort": {
                    "emotion": "relaxation, coziness, warmth",
                    "examples": [
                        f"Cozy {furniture_type} invites daily relaxation and comfort",
                        f"Soft {furniture_type} creates your perfect retreat space",
                        f"Comfortable {furniture_type} welcomes you home every day"
                    ] if furniture_type else [
                        "Sink into plush comfort daily",
                        "Soft textures invite pure relaxation"
                    ]
                },
                "Practical": {
                    "emotion": "quality, durability, smart investment",
                    "examples": [
                        f"Durable {furniture_type} built to last for years",
                        f"Quality {furniture_type} combines function with lasting beauty",
                        f"Sturdy {furniture_type} stands the test of time"
                    ] if furniture_type else [
                        "Premium materials ensure lasting beauty",
                        "Durable craftsmanship stands the test"
                    ]
                }
            }

            focus_info = focus_data[product_focus]

            prompt = f"""Create BALANCED poster text in English.

PRODUCT DETAILS:
- Type: {furniture_type if furniture_type else 'furniture'}
- Material: {product_brief if product_brief else 'premium quality'}
- Style: {attributes.get('style', 'modern')}
- Focus: {product_focus}
- Room: {room}
- Room Style: {room_style}

DISCOUNT: {discount}%

POSTER STYLE:
- Balance: Brief product detail + Strong emotion
- Natural, conversational tone
- Customer-focused
- MUST mention furniture type in description

REQUIREMENTS:

1. HEADLINE: 3-6 words
   {("- MUST include: " + str(discount) + "%" if discount > 0 else "")}
   - Focus on {product_focus} appeal

2. DESCRIPTION: 8-12 words
   - MUST naturally mention "{furniture_type if furniture_type else 'furniture'}"
   - Structure: [Type/Material] + [Emotional benefit]
   - Focus on {product_focus}: {focus_info['emotion']}
   - NO discount mention (already in headline)

   Style examples:
   {chr(10).join(f"   - {ex}" for ex in focus_info['examples'][:3])}

3. CTA: 2 words MAXIMUM
   Options: Shop Now, Discover More, Get Yours, Explore, Buy Today

CRITICAL: Description MUST include the furniture type naturally!

VARIATION: Every generation must be completely different.
- Use different words, structure, and creative angle
- Never repeat the same headline, description, or CTA as before

Format:
HEADLINE: [3-6 words]
DESCRIPTION: [8-12 words with furniture type]
CTA: [2 words]"""

        elif ad_type == "Offers":
            # Special offers/sales prompts - emphasize urgency and value
            urg_text = "URGENT" if urgency == "Urgent" else "NON-URGENT"

            prompt = f"""Create BALANCED offer text in English.

PRODUCT: {full_product}
DISCOUNT: {discount}%
URGENCY: {urg_text}

REQUIREMENTS:

1. HEADLINE: 4-6 words
   - MUST include "{discount}%"
   - Match urgency level

2. DESCRIPTION: 8-12 words
   - Mention "{furniture_type if furniture_type else 'furniture'}" naturally
   - Brief product + urgency/value
   - Natural flow
   - NO discount repeat

3. CTA: 2 words
   {"Urgent: Act Fast, Hurry Now, Shop Quick" if urgency == "Urgent" else "Options: Shop Now, Save Today, Get Deal"}

VARIATION: Every generation must be completely different.
- Use different words, structure, and creative angle
- Never repeat the same headline, description, or CTA as before

Format:
HEADLINE: [4-6 words]
DESCRIPTION: [8-12 words]
CTA: [2 words]"""

        elif ad_type == "Eid":
            # Eid celebration prompts - warm, family-oriented
            prompt = f"""Create BALANCED Eid text in English.

PRODUCT: {full_product}
DISCOUNT: {discount}%

REQUIREMENTS:

1. HEADLINE: 4-6 words
   - MUST mention "Eid"
   {("- Include: " + str(discount) + "%" if discount > 0 else "")}

2. DESCRIPTION: 8-12 words
   - Mention "{furniture_type if furniture_type else 'furniture'}" naturally
   - Brief product + Eid celebration emotion
   - Warm, joyful tone
   - NO discount repeat

3. CTA: 2 words
   Options: Shop Now, Celebrate Eid, Get Blessed

VARIATION: Every generation must be completely different.
- Use different words, structure, and creative angle
- Never repeat the same headline, description, or CTA as before



Format:
HEADLINE: [4-6 words]
DESCRIPTION: [8-12 words]
CTA: [2 words]"""

        else:  # National Day
            # Saudi National Day prompts - patriotic, heritage-focused
            prompt = f"""Create BALANCED National Day text in English.

PRODUCT: {full_product}
DISCOUNT: {discount}%

CONTEXT: Kingdom's unification, Saudi pride
USE: Kingdom, heritage, homeland, national pride

REQUIREMENTS:

1. HEADLINE: 4-6 words
   - Patriotic theme
   {("- Include: " + str(discount) + "%" if discount > 0 else "")}

2. DESCRIPTION: 8-12 words
   - Mention "{furniture_type if furniture_type else 'furniture'}" naturally
   - Brief product + heritage/Kingdom pride
   - Elegant patriotic tone
   - NO discount repeat

3. CTA: 2 words
   Options: Shop Now, Celebrate Today, Honor Nation


VARIATION: Every generation must be completely different.
- Use different words, structure, and creative angle
- Never repeat the same headline, description, or CTA as before

Format:
HEADLINE: [4-6 words]
DESCRIPTION: [8-12 words]
CTA: [2 words]"""

        # Call GPT-4o-mini to generate the marketing text
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": """Expert marketing copywriter for commercial posters.

STYLE GUIDE:
1. BALANCED APPROACH: Brief product detail + Strong emotion
2. NATURAL FLOW: Read like human conversation
3. CUSTOMER-FOCUSED: Benefits over features
4. CONCISE POWER: Every word earns its place
5. UNIQUE: Create fresh variations each time
6. TYPE MENTION: Always mention furniture type naturally

Description formula: [Furniture type + brief detail] + [emotional benefit/feeling]
Example: "Modern sofa brings cozy comfort to your space"
Example: "Elegant table transforms every dining moment beautifully"
"""
                },
                {"role": "user", "content": prompt}
            ],
            temperature=0.95,  # High temperature for creative variation
            top_p=0.95,
            max_tokens=250,
            presence_penalty=0.4,  # Reduce repetition
            frequency_penalty=0.4  # Encourage diversity
        )

        # Parse the response to extract headline, description, and CTA
        result = {'headline': '', 'description': '', 'cta': ''}
        for line in response.choices[0].message.content.split('\n'):
            line = line.strip()
            if line.startswith('HEADLINE:'):
                result['headline'] = line.replace('HEADLINE:', '').strip()
            elif line.startswith('DESCRIPTION:'):
                result['description'] = line.replace('DESCRIPTION:', '').strip()
            elif line.startswith('CTA:'):
                result['cta'] = line.replace('CTA:', '').strip()

        print(f"✅ Generated:")
        print(f"   Headline: {result['headline']}")
        print(f"   Description: {result['description']}")
        print(f"   CTA: {result['cta']}")

        return result


    def evaluate_text_quality(text: Dict, requirements: Dict) -> Dict:
        """
        Tool 3: Evaluate generated text quality using automated checks

        This is a simple rule-based evaluation that checks:
        - Length compliance (word counts)
        - Discount mention (if required)

        Pass threshold: 70%

        Args:
            text: Generated text to evaluate {headline, description, cta}
            requirements: Campaign requirements {discount, focus, etc}

        Returns:
            Dictionary with evaluation results {score, percentage, passed, issues}
        """
        print(f"\n📊 [TOOL] Evaluating text quality...")

        headline    = text.get('headline', '')
        description = text.get('description', '')
        cta         = text.get('cta', '')

        score     = 0
        max_score = 100
        issues    = []

        # Check 1: Headline length (3-6 words) - Worth 25 points
        h_words = len(headline.split())
        if 3 <= h_words <= 6:
            score += 25
        else:
            issues.append(f"Headline length: {h_words} words (need 3-6)")

        # Check 2: Description length (8-12 words) - Worth 35 points
        d_words = len(description.split())
        if 8 <= d_words <= 12:
            score += 35
        else:
            issues.append(f"Description length: {d_words} words (need 8-12)")

        # Check 3: CTA length (max 2 words) - Worth 15 points
        c_words = len(cta.split())
        if c_words <= 2:
            score += 15
        else:
            issues.append(f"CTA length: {c_words} words (max 2)")

        # Check 4: Discount mention (if required) - Worth 25 points
        discount = requirements.get('discount', 0)
        if discount > 0:
            # Check if discount percentage is mentioned in headline
            if '%' in headline or str(discount) in headline:
                score += 25
            else:
                issues.append(f"Missing {discount}% in headline")
        else:
            # No discount required, give full points
            score += 25

        # Calculate percentage and determine pass/fail
        percentage = score
        passed     = percentage >= 70  # 70% is the pass threshold

        assessment = "PASS" if passed else "FAIL"

        # Print evaluation results
        print(f"{'='*60}")
        print(f"Score: {score}/100 ({percentage}%)")
        print(f"Assessment: {assessment}")
        print(f"Headline: {h_words} words {'✓' if 3 <= h_words <= 6 else '✗'}")
        print(f"Description: {d_words} words {'✓' if 8 <= d_words <= 12 else '✗'}")
        print(f"CTA: {c_words} words {'✓' if c_words <= 2 else '✗'}")
        print(f"Discount: {'✓' if discount == 0 or '%' in headline else '✗'}")
        if issues:
            print(f"\nIssues found:")
            for issue in issues:
                print(f"  - {issue}")
        print(f"{'='*60}\n")

        return {
            "score":      score,
            "percentage": percentage,
            "passed":     passed,
            "assessment": assessment,
            "issues":     issues,
            "details": {
                "headline_words":    h_words,
                "description_words": d_words,
                "cta_words":         c_words,
                "discount_mentioned": '%' in headline if discount > 0 else True
            }
        }


    # ════════════════════════════════════════════════════════════════
    # AI Agent System — IDENTICAL to Colab notebook
    # ════════════════════════════════════════════════════════════════

    def run_agent(image_path: str, settings: Dict) -> Dict:
        """
        Main AI Agent function - makes autonomous decisions using Claude

        The agent:
        1. Receives a task (create poster text)
        2. Decides which tools to use and when
        3. Evaluates its own output
        4. Regenerates if quality is low
        5. Returns final result

        This is different from a simple pipeline because the agent
        makes its own decisions at each step rather than following
        a predetermined sequence.

        Args:
            image_path: Path to furniture image file
            settings: Dictionary with campaign settings (ad_type, discount, etc)

        Returns:
            Dictionary with final results and metadata
        """

        print("\n" + "="*60)
        print("🤖 AI AGENT STARTED")
        print("="*60)
        print(f"Task: Create {settings['ad_type']} poster text")
        print(f"Image: {image_path}")
        print(f"Settings: {json.dumps(settings, indent=2)}")
        print("="*60)

        start_time = time.time()

        # Define tools that the agent can use
        # These are function definitions in Claude's tool-calling format
        tools = [
            {
                "name": "extract_attributes",
                "description": "Extract furniture attributes (type, material, color, style) from image using Vision AI",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "image_path": {
                            "type": "string",
                            "description": "Path to the furniture image file"
                        }
                    },
                    "required": ["image_path"]
                }
            },
            {
                "name": "generate_marketing_text",
                "description": "Generate professional marketing poster text (headline, description, CTA) based on attributes and campaign settings",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "attributes": {
                            "type": "object",
                            "description": "Furniture attributes from extraction"
                        },
                        "ad_type": {
                            "type": "string",
                            "enum": ["Product ad", "Offers", "Eid", "National Day"]
                        },
                        "product_focus": {
                            "type": "string",
                            "enum": ["Aesthetic", "Comfort", "Practical"]
                        },
                        "discount": {
                            "type": "number",
                            "description": "Discount percentage (0-70)"
                        },
                        "room":       {"type": "string"},
                        "room_style": {"type": "string"},
                        "lighting":   {"type": "string"},
                        "urgency":    {"type": "string"}
                    },
                    "required": ["attributes", "ad_type"]
                }
            },
            {
                "name": "evaluate_text_quality",
                "description": "Evaluate generated text quality with automated checks. Pass threshold is 70%. Returns score, issues, and pass/fail status.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "object",
                            "properties": {
                                "headline":    {"type": "string"},
                                "description": {"type": "string"},
                                "cta":         {"type": "string"}
                            },
                            "required": ["headline", "description", "cta"]
                        },
                        "requirements": {
                            "type": "object",
                            "description": "Campaign requirements (discount, focus, etc)"
                        }
                    },
                    "required": ["text", "requirements"]
                }
            }
        ]

        # Initial instruction to the agent
        # This tells Claude what to do, but not HOW to do it
        # Claude will decide which tools to use and in what order
        messages = [{
            "role": "user",
            "content": f"""You are an AI agent for generating furniture poster marketing text.

Your task:
1. Extract attributes from the image at: {image_path}
2. Generate professional marketing text based on these settings:
{json.dumps(settings, indent=2)}

3. Evaluate the quality (must score ≥70%)
4. If quality is low, regenerate with improvements
5. Maximum 3 generation attempts
6. Return final result when quality passes

IMPORTANT: The description MUST mention the furniture type naturally!

Think step by step. Use available tools to complete the task."""
        }]

        # Agent loop - continues until task is complete
        iteration          = 0
        max_iterations     = 10
        generation_attempts = 0
        final_text         = None

        while iteration < max_iterations:
            iteration += 1
            print(f"\n{'🔄 ITERATION ' + str(iteration):-^60}")

            # Ask Claude to decide what to do next
            response = anthropic_client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                tools=tools,
                messages=messages
            )

            print(f"💭 Agent decision: {response.stop_reason}")

            # Check what Claude decided to do
            if response.stop_reason == "tool_use":
                # Claude wants to use a tool
                # Extract which tool and what inputs
                tool_use_block = next(
                    block for block in response.content
                    if block.type == "tool_use"
                )

                tool_name  = tool_use_block.name
                tool_input = tool_use_block.input

                print(f"🔧 Agent chose tool: {tool_name}")
                _prog(f"Agent using tool: {tool_name}")

                # Execute the tool that Claude requested
                if tool_name == "extract_attributes":
                    result = extract_attributes(tool_input["image_path"])

                elif tool_name == "generate_marketing_text":
                    generation_attempts += 1
                    result = generate_marketing_text(
                        tool_input["attributes"],
                        tool_input.get("ad_type",       settings["ad_type"]),
                        tool_input.get("product_focus", settings.get("product_focus", "Aesthetic")),
                        tool_input.get("discount",      settings.get("discount", 0)),
                        tool_input.get("room",          settings.get("room", "Living Room")),
                        tool_input.get("room_style",    settings.get("room_style", "Modern")),
                        tool_input.get("lighting",      settings.get("lighting", "Sunlight")),
                        tool_input.get("urgency",       settings.get("urgency", "Non-urgent"))
                    )
                    # Store the generated text
                    final_text = result

                elif tool_name == "evaluate_text_quality":
                    result = evaluate_text_quality(
                        tool_input["text"],
                        tool_input.get("requirements", settings)
                    )

                # Add Claude's response to conversation history
                messages.append({
                    "role": "assistant",
                    "content": response.content
                })

                # Add tool result back to Claude
                # This lets Claude see the result and decide what to do next
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_block.id,
                        "content": json.dumps(result, indent=2)
                    }]
                })

            elif response.stop_reason == "end_turn":
                # Claude finished the task
                print(f"\n{'✅ AGENT COMPLETED':-^60}")

                # Extract Claude's final response
                final_response = next(
                    (block.text for block in response.content if block.type == "text"),
                    "Task completed"
                )

                elapsed_time = time.time() - start_time

                print(f"\n📝 Agent's final response:")
                print(final_response)
                print(f"\n⏱️  Total time: {elapsed_time:.2f}s")
                print(f"🔄 Generation attempts: {generation_attempts}")

                return {
                    "final_response":      final_response,
                    "final_text":          final_text,
                    "generation_attempts": generation_attempts,
                    "elapsed_time":        elapsed_time,
                    "iterations":          iteration,
                    "success":             True
                }

            time.sleep(0.5)  # Small delay to avoid rate limits

        # If we reach here, agent exceeded max iterations
        raise Exception("Agent exceeded maximum iterations without completing task")

    # ── Run agent and extract result ──────────────────────────────
    _prog("Running Text Agent…")
    result = run_agent(image_path, settings)

    ft = result.get("final_text") or {}
    return {
        "headline":    ft.get("headline",    ""),
        "description": ft.get("description", ""),
        "cta":         ft.get("cta",         "Shop Now"),
    }
