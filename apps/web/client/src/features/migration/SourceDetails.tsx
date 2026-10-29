import { useRef } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Button } from "../../ui";
import { chooseResourceDirectory } from "../workspace/actions";
import { scanMigration, setMcpSourcePath, setSourceProjects } from "./actions";
import { SourceLogo } from "./CandidateList";
import { useMigrationStore } from "./store";

/** One source per line: logo · app name · path (ellipsis) · status dot on the right. */
function SourceStatus({ status }: { readonly status: string }) {
	const t = useT();
	return (
		<span className="migration-source-status">
			<i aria-hidden="true" />
			{t(`migrationScanStatus.${status}`)}
		</span>
	);
}
export function SourceDetails() {
	const t = useT();
	const kind = useMigrationStore((state) => state.kind);
	const scan = useMigrationStore((state) => state.scan);
	const sources = useMigrationStore((state) => state.mcpSourcePaths);
	const projects = useMigrationStore((state) => state.projectCwds);
	const registered = new Set(
		useAppStore((state) => state.workspaces)
			.filter((workspace) => workspace.available && !workspace.hidden)
			.map((workspace) => workspace.path),
	);
	const disabled = useMigrationStore((state) => state.scanning || !!state.busy);
	const picking = useRef(false);
	const pick = async (source?: "claude-code" | "codex") => {
		if (picking.current) return;
		picking.current = true;
		try {
			const directory = await chooseResourceDirectory(t(source ? "migrationPickMcpSource" : "migrationPickSource"));
			if (!directory) return;
			if (source)
				setMcpSourcePath(
					source,
					`${directory.replace(/[\\/]+$/u, "")}/${source === "codex" ? "config.toml" : ".claude.json"}`,
				);
			else setSourceProjects([...new Set([...projects, directory])]);
			void scanMigration(kind);
		} finally {
			picking.current = false;
		}
	};
	return (
		<details className="migration-source-locations">
			<summary>{t("migrationSourceDetails")}</summary>
			<div className="migration-source-location-body">
				{(scan?.sources ?? [])
					.filter((report) => report.kind === kind)
					.map((report, index) => (
						<div
							className="migration-source-location"
							data-scan-status={report.status}
							key={`${report.path}:${index}`}
						>
							<SourceLogo source={report.source} />
							<strong>{t(`migrationSource.${report.source}`)}</strong>
							<code title={report.path}>{report.path}</code>
							<SourceStatus status={report.status} />
						</div>
					))}
				{kind === "mcp"
					? (["claude-code", "codex"] as const).map((source) => (
							<div className="migration-source-location" key={source}>
								<SourceLogo source={source} />
								<strong>{t(`migrationSource.${source}`)}</strong>
								<code title={sources[source] ?? t(`migrationMcpDefaultPath.${source}`)}>
									{sources[source] ?? t(`migrationMcpDefaultPath.${source}`)}
								</code>
								<div className="migration-source-actions">
									<Button
										className="migration-source-action"
										disabled={disabled}
										onClick={() => void pick(source)}
									>
										{t("migrationChangeSource")}
									</Button>
									{sources[source] ? (
										<Button
											className="migration-source-action"
											disabled={disabled}
											onClick={() => {
												setMcpSourcePath(source);
												void scanMigration(kind);
											}}
										>
											{t("migrationDefaultSource")}
										</Button>
									) : null}
								</div>
							</div>
						))
					: null}
				{kind === "rules" ? (
					<>
						<div className="migration-source-location">
							<strong>{t("migrationSourceProjects")}</strong>
							<div className="migration-source-actions">
								<Button
									id="migrationAddSourceFolder"
									className="migration-source-action"
									disabled={disabled}
									onClick={() => void pick()}
								>
									{t("migrationAddSourceFolder")}
								</Button>
							</div>
						</div>
						{projects.map((cwd) => (
							<div className="migration-source-location" key={cwd}>
								<code title={cwd}>{cwd}</code>
								{registered.has(cwd) ? null : (
									<div className="migration-source-actions">
										<span className="migration-pill migration-pill-attention">
											{t("migrationUnregisteredSource")}
										</span>
									</div>
								)}
							</div>
						))}
					</>
				) : null}
			</div>
		</details>
	);
}
