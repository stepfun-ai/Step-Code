import { useState } from "react";
import { useT } from "../../i18n";
import { activeRightPanel } from "../../state/right-panel";
import { copyText } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Icon, IconButton, type IconName, Tooltip } from "../../ui";
import { toggleDeliveryFile } from "../files/actions";
import type { TurnArtifact } from "./turn-artifacts";

export function TurnArtifacts({
	artifacts,
	cwd,
}: {
	readonly artifacts: readonly TurnArtifact[];
	readonly cwd: string;
}) {
	const t = useT();
	const [showAll, setShowAll] = useState(false);
	const activePath = useAppStore((state) => {
		const tab = state.preview.tabs[state.preview.active];
		return activeRightPanel(state) === "files" && tab?.kind === "file" && tab.cwd === cwd ? tab.path : null;
	});
	if (!artifacts.length) return null;
	return (
		<section className="turn-artifacts" aria-label={t("turnOutputs")}>
			<span className="artifact-strip-label">{t("outputs")}</span>
			<div className="artifact-entries">
				{(showAll ? artifacts : artifacts.slice(0, 3)).map((artifact) => {
					const icon: IconName =
						artifact.kind === "image"
							? "image"
							: artifact.kind === "website"
								? "globe"
								: artifact.kind === "document"
									? "fileText"
									: "file";
					return (
						<div className="artifact-row" key={artifact.path}>
							<Tooltip content={artifact.path}>
								<button
									type="button"
									className="artifact-main"
									aria-controls="rightPanel"
									aria-expanded={activePath === artifact.path}
									onClick={() => void toggleDeliveryFile(cwd, artifact.path)}
								>
									<Icon name={icon} size="xs" />
									<span>{artifact.label}</span>
									<Icon name="open" size="xs" />
								</button>
							</Tooltip>
							<Tooltip content={t("copyPath")}>
								<IconButton
									className="artifact-copy"
									icon="copy"
									iconSize="xs"
									aria-label={`${t("copyPath")}: ${artifact.path}`}
									onClick={() => void copyText(artifact.path)}
								/>
							</Tooltip>
						</div>
					);
				})}
				{artifacts.length > 3 ? (
					<button
						type="button"
						className="artifact-more"
						aria-expanded={showAll}
						onClick={() => setShowAll(!showAll)}
					>
						{t(showAll ? "outputsLess" : "outputsMore", { count: artifacts.length - 3 })}
					</button>
				) : null}
			</div>
			<span className="artifact-count">{t("outputsCount", { count: artifacts.length })}</span>
		</section>
	);
}
