import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { SessionInspector } from "../../state/types";
import { Icon } from "../../ui";
import { effectiveTaskStatus, sessionIsLive } from "./model";
import { SummaryAgents } from "./SummaryAgents";
import { SummaryTaskStatus } from "./SummaryTaskStatus";

type Task = SessionInspector["tasks"][number];

function TaskRow({
	task,
	live,
	visible,
	entering,
}: {
	readonly task: Task;
	readonly live: boolean;
	readonly visible: boolean;
	readonly entering: boolean;
}) {
	const [open, setOpen] = useState(false);
	const t = useT();
	const [isNew] = useState(entering);
	const id = useId();
	const status = effectiveTaskStatus(task.status, live);
	return (
		<li
			className={`sb-disclosure sb-task-shell${isNew ? " is-new" : ""}${visible ? " is-open" : ""}`}
			aria-hidden={!visible}
			inert={!visible}
		>
			<div>
				<div className={`sb-step is-${status}`}>
					<button
						className="sb-step-trigger"
						type="button"
						aria-label={`${task.subject} · ${t(`subagentStatus.${status === "pending" ? "queued" : status === "in_progress" ? "running" : status}`)}`}
						aria-expanded={open}
						aria-controls={id}
						onClick={() => setOpen(!open)}
					>
						<span className="sb-step-symbol">
							<SummaryTaskStatus status={status} />
						</span>
						<span>{task.subject}</span>
						<Icon name="disclosure" size="xs" className={`sb-fold-icon${open ? " is-open" : ""}`} />
					</button>
					<div id={id} className={`sb-disclosure${open ? " is-open" : ""}`} aria-hidden={!open} inert={!open}>
						<div>
							<p className="sb-step-detail">{task.description || task.subject}</p>
						</div>
					</div>
				</div>
			</div>
		</li>
	);
}

export function SummaryBoard({ data }: { readonly data?: SessionInspector }) {
	const t = useT();
	const current = useAppStore((state) => state.current);
	const live = sessionIsLive(current?.status);
	const [completedOpen, setCompletedOpen] = useState(false);
	const [recent, setRecent] = useState<string[]>([]);
	const previous = useRef(new Map<string, Task["status"]>());
	const hasSnapshot = useRef(false);
	useLayoutEffect(() => {
		// An unavailable refresh is not a new history snapshot.
		if (!data) return;
		const completed = data.tasks
			.filter((task) => {
				const before = previous.current.get(`${data.plan?.id ?? ""}:${task.id}`);
				return task.status === "completed" && before !== undefined && before !== "completed";
			})
			.map((task) => `${data.plan?.id ?? ""}:${task.id}`);
		previous.current = new Map(data.tasks.map((task) => [`${data.plan?.id ?? ""}:${task.id}`, task.status]));
		hasSnapshot.current = true;
		if (completed.length) setRecent((ids) => [...new Set([...ids, ...completed])]);
	}, [data]);
	useEffect(() => {
		if (!recent.length) return;
		const timer = setTimeout(() => setRecent([]), 1100);
		return () => clearTimeout(timer);
	}, [recent]);
	const tasks = data?.tasks ?? [];
	const done = tasks.filter((task) => task.status === "completed");
	return (
		<div className="sb-content">
			<section className="sb-steps">
				<div className="sb-section-heading">
					<h3>{t("rightTasks")}</h3>
					<span>
						{data ? (
							<>
								<strong>{done.length}</strong> / {tasks.length}
							</>
						) : (
							"--"
						)}
					</span>
				</div>
				{data?.plan ? <p className="sb-plan-title">{data.plan.title}</p> : null}
				{done.length ? (
					<button
						className="sb-completed-trigger"
						type="button"
						aria-expanded={completedOpen}
						onClick={() => setCompletedOpen(!completedOpen)}
					>
						<Icon name="check" size="xs" />
						<span>{t("rightCompleted", { count: done.length })}</span>
						<Icon name="disclosure" size="xs" className={`sb-fold-icon${completedOpen ? " is-open" : ""}`} />
					</button>
				) : null}
				<ol>
					{tasks.map((task) => {
						const key = `${data?.plan?.id ?? ""}:${task.id}`;
						return (
							<TaskRow
								key={key}
								task={task}
								live={live}
								entering={hasSnapshot.current && !previous.current.has(key)}
								visible={task.status !== "completed" || completedOpen || recent.includes(key)}
							/>
						);
					})}
				</ol>
				{!tasks.length ? (
					<p className="sb-state">{t(!current ? "rightNoSession" : data ? "noTasks" : "settingsLoading")}</p>
				) : null}
				{tasks.length ? (
					<div
						className="sb-task-progress"
						role="progressbar"
						aria-label={t("rightTasks")}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round((done.length / tasks.length) * 100)}
						aria-valuetext={t("rightTaskProgress", { done: done.length, total: tasks.length })}
					>
						<div className="sb-task-progress-fill" style={{ width: `${(done.length / tasks.length) * 100}%` }} />
					</div>
				) : null}
			</section>
			<SummaryAgents />
		</div>
	);
}
