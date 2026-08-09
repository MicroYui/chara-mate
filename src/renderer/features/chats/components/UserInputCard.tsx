import { MessageCircleQuestion } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  RequestUserInputArguments,
  UserInputAnswer,
  UserInputResolution,
} from "../../../../shared/contracts";
import { RequestUserInputArgumentsSchema } from "../../../../shared/schemas/run";
import { parseSchemaWithoutCodeGeneration } from "../../../../shared/schemas/valueValidation";
import styles from "./UserInputCard.module.css";

type DraftAnswer = UserInputAnswer["value"];

interface UserInputCardProps {
  readonly input: unknown;
  readonly onResolve: (resolution: UserInputResolution) => Promise<void>;
}

export function readUserInputRequest(
  input: unknown,
): RequestUserInputArguments | undefined {
  try {
    return parseSchemaWithoutCodeGeneration(
      RequestUserInputArgumentsSchema,
      input,
    );
  } catch {
    return undefined;
  }
}

export function UserInputCard({ input, onResolve }: UserInputCardProps) {
  const request = useMemo(() => readUserInputRequest(input), [input]);
  const [answers, setAnswers] = useState<Readonly<Record<string, DraftAnswer>>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);

  if (!request) return null;
  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return (
      answer !== undefined &&
      (answer.kind === "option" || answer.text.trim().length > 0)
    );
  });

  const resolve = async (resolution: UserInputResolution): Promise<void> => {
    setSubmitting(true);
    try {
      await onResolve(resolution);
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles["card"]} aria-label="需要补充信息">
      <header>
        <span className={styles["icon"]}>
          <MessageCircleQuestion aria-hidden="true" size={16} />
        </span>
        <div>
          <strong>需要你补充一下</strong>
          <p>回答后会继续当前任务。</p>
        </div>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || submitting) return;
          const submittedAnswers = request.questions.map(
            (question): UserInputAnswer => ({
              questionId: question.id,
              value: answers[question.id]!,
            }),
          );
          void resolve({
            answers: submittedAnswers,
            resolvedAt: new Date().toISOString(),
            status: "answered",
          });
        }}
      >
        {request.questions.map((question) => {
          const answer = answers[question.id];
          return (
            <fieldset key={question.id} disabled={submitting}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              <div className={styles["options"]}>
                {question.options.map((option) => (
                  <label
                    key={option.label}
                    data-selected={
                      answer?.kind === "option" && answer.label === option.label
                    }
                  >
                    <input
                      checked={
                        answer?.kind === "option" &&
                        answer.label === option.label
                      }
                      name={`question-${question.id}`}
                      type="radio"
                      onChange={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: {
                            kind: "option",
                            label: option.label,
                          },
                        }))
                      }
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
                <label data-selected={answer?.kind === "text"}>
                  <input
                    checked={answer?.kind === "text"}
                    name={`question-${question.id}`}
                    type="radio"
                    onChange={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: { kind: "text", text: "" },
                      }))
                    }
                  />
                  <span>
                    <strong>其他</strong>
                    <small>输入更适合你的答案</small>
                  </span>
                </label>
              </div>
              {answer?.kind === "text" ? (
                <textarea
                  autoFocus
                  aria-label={`${question.header}的其他答案`}
                  maxLength={500}
                  placeholder="请输入你的答案"
                  value={answer.text}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: {
                        kind: "text",
                        text: event.target.value,
                      },
                    }))
                  }
                />
              ) : null}
            </fieldset>
          );
        })}
        <footer>
          <button
            type="button"
            disabled={submitting}
            onClick={() =>
              void resolve({
                resolvedAt: new Date().toISOString(),
                status: "cancelled",
              })
            }
          >
            取消
          </button>
          <button
            className={styles["submit"]}
            type="submit"
            disabled={!complete || submitting}
          >
            {submitting ? "提交中…" : "提交并继续"}
          </button>
        </footer>
      </form>
    </section>
  );
}
