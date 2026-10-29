import { useRef } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Button } from "../../ui";
import { chooseResourceDirectory } from "../workspace/actions";
import { scanMigration, setMcpSourcePath, setSourceProjects } from "./actions";
import { SourceLogo } from "./CandidateList";
import { useMigrationStore } from "./store";

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
						<div key={`${report.path}:${index}`}>
							<div className="migration-source-location" data-scan-status={report.status}>
								<SourceLogo source={report.source} />
								<div>
									<strong>{t(`migrationSource.${report.source}`)}</strong>
									<code>{report.path}</code>
								</div>
								<div className="migration-source-actions">
									<span
										className={`migration-pill${report.status === "error" || report.status === "partial" ? " migration-pill-attention" : report.status === "ok" ? " migration-pill-success" : ""}`}
									>
										{t(`migrationScanStatus.${report.status}`)}
									</span>
								</div>
							</div>
						</div>
					))}
				{kind === "mcp"
					? (["claude-code", "codex"] as const).map((source) => (
							<div className="migration-source-location" key={source}>
								<SourceLogo source={source} />
								<div>
									<strong>{t(`migrationSource.${source}`)}</strong>
									<code>{sources[source] ?? t(`migrationMcpDefaultPath.${source}`)}</code>
								</div>
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
						<div className="migration-source-actions migration-source-actions-row">
							<Button
								id="migrationAddSourceFolder"
								className="migration-source-action"
								disabled={disabled}
								onClick={() => void pick()}
							>
								{t("migrationAddSourceFolder")}
							</Button>
						</div>
						{projects.map((cwd) => (
							<div className="migration-source-location" key={cwd}>
								<div>
									<code>{cwd}</code>
								</div>
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
