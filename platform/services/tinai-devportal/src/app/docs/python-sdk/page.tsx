import type { Metadata } from "next";
import { CodeBlock } from "../../components/CodeBlock";

export const metadata: Metadata = {
  title: "Python SDK",
  description: "Tinai Python SDK — install, authenticate, and call all Phase 1 APIs.",
};

const INSTALL = `pip install tinai-sdk`;

const BASIC = `
from tinai import Client

client = Client(api_key="tn_prod_agri_32hexchars00000000000000000000")

# Mandi prices
result = client.agri.mandi_prices(lat=18.52, lng=73.85, crop="tomato")
print(result.best_price_per_quintal)   # 3200
print(result.best_mandi.mandi_name)    # "Nashik APMC"
print(result.cache_hit)                # True / False

# Scheme eligibility
schemes = client.agri.scheme_eligibility(
    state="maharashtra", land_area_acres=2.5, crops=["wheat"]
)
for s in schemes.eligible_schemes:
    print(s.scheme_name, s.benefit_amount_inr)

# Unified advisory (async job — SDK polls automatically)
advisory = client.agri.advisory(
    lat=18.52, lng=73.85, crops=["tomato"], state="maharashtra", language="hi"
)
print(advisory.summary)
print(advisory.mandi_best_price)
`;

const BHASHINI = `
# Translate
result = client.bhashini.translate("Good morning", source="en", target="hi")
print(result.first)                    # "सुप्रभात"
print(result.latency_ms)

# Transliterate
t = client.bhashini.transliterate("namaste", source_script="Latin", target="hi")
print(t.first)                         # "नमस्ते"

# Synthesize speech (returns audio bytes)
audio = client.bhashini.synthesize("नमस्ते", language="hi", gender="female")
audio.save("/tmp/greeting.wav")        # helper method
`;

const EDU = `
# Start adaptive session
session = client.edu.start_session(
    student_id="stu_001", subject="math", grade=10, exam_type="jee_main"
)

# Get next question
q = client.edu.next_question(session.session_id)
print(q.question_text)
print(q.difficulty)     # 0.0–1.0 (IRT difficulty parameter)

# Submit answer
result = client.edu.submit_answer(
    session_id=session.session_id,
    question_id=q.question_id,
    answer="B",
    time_taken_s=45,
)
print(result.correct)
print(result.explanation)

# Get study plan
plan = client.edu.study_plan(student_id="stu_001", target_exam="jee_main", days_left=90)
for topic in plan.topics[:3]:
    print(topic.name, topic.priority_score)
`;

const SKILL = `
# Certificate verification (no auth required)
cert = client.skill.verify_certificate("PMKVY/2025/MH/AGR/000001")
print(cert.valid)            # True
print(cert.hash_matches)     # True — tamper-evident
print(cert.student_name)     # "Ramesh Kumar"
print(cert.nsqf_level)       # 4

# Course catalog
courses = client.skill.course_catalog(sector="agriculture", state="maharashtra")
for c in courses:
    print(c.course_name, c.duration_hours, c.nsqf_level)

# Enroll student
enrollment = client.skill.enroll(
    student_id="stu_001", course_id=courses[0].course_id
)
print(enrollment.enrollment_id)
`;

const ERRORS = `
from tinai.exceptions import AuthError, RateLimitError, ValidationError, AdvisoryTimeoutError

try:
    result = client.agri.mandi_prices(lat=18.52, lng=73.85, crop="tomato")
except AuthError as e:
    print(f"Invalid key: {e.status_code}")
except RateLimitError as e:
    print(f"Quota exceeded. Resets at: {e.reset_at}")
except ValidationError as e:
    print(f"Bad input: {e}")
except AdvisoryTimeoutError:
    print("Advisory job timed out — retry with longer poll_timeout_s")
`;

export default function PythonSdkPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-14 pb-20">
      <div className="mb-2 text-xs text-[var(--muted)]">
        <a href="/docs" className="hover:text-white transition-colors">Docs</a>
        <span className="mx-2">/</span>
        Python SDK
      </div>
      <h1 className="text-4xl font-bold text-white mb-3">Python SDK</h1>
      <p className="text-[var(--muted)] text-lg mb-10">
        Zero runtime dependencies. Python ≥ 3.10. Uses stdlib{" "}
        <code className="text-[var(--accent)]">urllib.request</code> only.
      </p>

      <Section title="Installation">
        <CodeBlock code={INSTALL} lang="bash" />
      </Section>

      <Section title="API key format">
        <p className="text-sm text-[var(--muted)] mb-3">
          Keys are 45 characters: <code className="text-[var(--accent)]">tn_&#123;env&#125;_&#123;type&#125;_&#123;32hex&#125;</code>.
          Get yours at{" "}
          <a href="/keys" className="text-[var(--accent)] hover:underline">dev.tinai.cloud/keys</a>.
        </p>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 font-mono text-sm text-[var(--muted)]">
          tn_prod_agri_<span className="text-[var(--accent)]">a1b2c3d4e5f6...</span>
          <span className="ml-4 text-xs text-[var(--muted)]/60"># 32 hex chars</span>
        </div>
      </Section>

      <Section title="Agri API">
        <CodeBlock code={BASIC} lang="python" filename="agri_example.py" />
      </Section>

      <Section title="Bhashini API">
        <CodeBlock code={BHASHINI} lang="python" filename="bhashini_example.py" />
      </Section>

      <Section title="Edu API">
        <CodeBlock code={EDU} lang="python" filename="edu_example.py" />
      </Section>

      <Section title="Skill API">
        <CodeBlock code={SKILL} lang="python" filename="skill_example.py" />
      </Section>

      <Section title="Error handling">
        <CodeBlock code={ERRORS} lang="python" filename="error_handling.py" />
        <div className="mt-4 rounded-lg border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--card)] border-b border-[var(--border)]">
              <tr>
                <th className="text-left px-4 py-2 text-[var(--muted)] font-medium">Exception</th>
                <th className="text-left px-4 py-2 text-[var(--muted)] font-medium">HTTP</th>
                <th className="text-left px-4 py-2 text-[var(--muted)] font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[
                ["AuthError", "401", "Invalid or expired API key"],
                ["RateLimitError", "429", "Daily quota exceeded"],
                ["ValidationError", "422", "Bad request parameters"],
                ["NotFoundError", "404", "Resource not found"],
                ["AdvisoryTimeoutError", "—", "Advisory poll_timeout_s exceeded"],
              ].map(([exc, code, desc]) => (
                <tr key={exc}>
                  <td className="px-4 py-2 font-mono text-[var(--accent)] text-xs">{exc}</td>
                  <td className="px-4 py-2 text-[var(--muted)]">{code}</td>
                  <td className="px-4 py-2 text-[var(--muted)]">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-semibold text-white mb-4 pb-2 border-b border-[var(--border)]">
        {title}
      </h2>
      {children}
    </section>
  );
}
