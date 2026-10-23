/**
 * `.user-area` at the foot of the sidebar: the signed-in account on the left,
 * and two icon buttons on the right. The phone button is a placeholder for
 * mobile remote control (not available yet); the gear opens the settings view.
 *
 * The account shows the nickname and avatar the host reads from the account
 * session (`GET /api/v1/account`). Without one (API-key sign-in, or the
 * developer center unreachable) it falls back to a label for the credential.
 * Pressing it opens `#accountMenu` above it: the account (avatar, name, id)
 * and the account actions, Upgrade and Log out. Signed out there is no account
 * to show, so the button opens Settings > Account, the in-app sign-in, directly.
 */

import { useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { copyText } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { AccountReport, LoginReport } from "../../state/types";
import { Icon, IconButton, Menu, MenuDivider, MenuItem, Popover, Tooltip } from "../../ui";
import { openLoginPage } from "../login/actions";
import { openSettings } from "../settings/actions";
import { canLogout, logout, stepPlanUrl } from "./actions";

function isStepPlan(login: LoginReport | null): boolean {
	return login?.source === "auth.json" && login.profile?.startsWith("step_plan") === true;
}

/** The name to show; empty while a Step Plan account is still being looked up. */
function accountName(t: TranslateFn, login: LoginReport | null, account: AccountReport | null): string {
	if (!login?.configured) return t("footerSignedOut");
	if (account?.account) return account.account.name;
	if (!isStepPlan(login)) return t("footerApiKey");
	// The key still runs models, but the account identity is gone: say so instead
	// of claiming the Step Plan account is signed in.
	if (login.session?.state === "expired") return t("footerSessionExpired");
	return account ? t("footerSignedIn") : "";
}

function AccountAvatar({ name, url, className }: { name: string; url: string | undefined; className?: string }) {
	// Remember which URL failed, so a new URL gets a fresh attempt.
	const [brokenUrl, setBrokenUrl] = useState<string>();
	return (
		<span className={className ? `user-avatar ${className}` : "user-avatar"} aria-hidden="true">
			{url && url !== brokenUrl ? (
				<img
					className="user-avatar-image"
					src={url}
					alt=""
					referrerPolicy="no-referrer"
					draggable={false}
					onError={() => setBrokenUrl(url)}
				/>
			) : (
				name.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}

const closeAccountMenu = () => setUi({ accountMenuOpen: false });

/** The button label for the current credential state. */
function accountLabel(t: TranslateFn, login: LoginReport | null, account: AccountReport | null): string {
	if (!login?.configured) return t("footerSignedOut");
	return accountName(t, login, account);
}

function AccountMenu({
	name,
	avatarUrl,
	uid,
}: {
	name: string;
	avatarUrl: string | undefined;
	uid: string | undefined;
}) {
	const t = useT();
	const planUrl = useAppStore((state) => stepPlanUrl(state.login));
	const removable = useAppStore((state) => canLogout(state.login));
	return (
		<>
			<div className="account-menu-header">
				<AccountAvatar name={name} url={avatarUrl} className="large" />
				<div className="account-menu-identity">
					<span className="account-menu-name">{name}</span>
					{uid ? (
						<span className="account-menu-id">
							<span id="accountMenuId">{t("accountId", { uid })}</span>
							<Tooltip content={t("copyAccountId")}>
								<IconButton
									className="account-menu-copy"
									icon="copy"
									iconSize="xs"
									aria-label={t("copyAccountId")}
									onClick={() => void copyText(uid)}
								/>
							</Tooltip>
						</span>
					) : null}
				</div>
			</div>
			<MenuDivider />
			<Menu bare role="menu" aria-label={t("footerAccount", { name })}>
				<MenuItem
					role="menuitem"
					id="accountUpgradeButton"
					data-href={planUrl}
					icon="upgrade"
					onClick={() => {
						closeAccountMenu();
						openLoginPage(planUrl);
					}}
				>
					{t("upgrade")}
				</MenuItem>
				<MenuItem
					role="menuitem"
					id="accountLogoutButton"
					icon="logout"
					danger
					disabled={!removable}
					onClick={() => {
						closeAccountMenu();
						logout();
					}}
				>
					{t("logout")}
				</MenuItem>
			</Menu>
		</>
	);
}

export function UserArea() {
	const t = useT();
	const login = useAppStore((state) => state.login);
	const account = useAppStore((state) => state.account);
	const name = accountLabel(t, login, account);
	const signedIn = login?.configured === true;
	const avatarUrl = login?.configured ? account?.account?.avatarUrl : undefined;
	const uid = login?.configured ? account?.account?.uid : undefined;
	const menuOpen = useAppStore((state) => state.ui.accountMenuOpen);
	return (
		<div className="user-area">
			{/* Escape belongs to the shell's chain. */}
			<Popover
				className="account-menu"
				id="accountMenu"
				placement="top-start"
				open={signedIn && menuOpen}
				onClose={closeAccountMenu}
				closeOnEscape={false}
				content={<AccountMenu name={name} avatarUrl={avatarUrl} uid={uid} />}
			>
				<button
					type="button"
					className="user-account"
					id="userAccountButton"
					aria-label={signedIn ? t("footerAccount", { name }) : t("accountSignIn")}
					aria-haspopup={signedIn ? "menu" : undefined}
					aria-expanded={signedIn ? menuOpen : undefined}
					aria-controls={signedIn ? "accountMenu" : undefined}
					onClick={() => {
						if (signedIn) {
							setUi((ui) => ({ accountMenuOpen: !ui.accountMenuOpen }));
							return;
						}
						closeAccountMenu();
						openSettings("account");
					}}
				>
					<AccountAvatar name={name} url={avatarUrl} />
					<span className="user-name">{name}</span>
				</button>
			</Popover>
			<div className="user-actions">
				<Tooltip
					id="remoteControlTip"
					className="footer-tooltip"
					content={
						<>
							<strong>{t("remoteControl")}</strong>
							<span>{t("remoteControlOff")}</span>
						</>
					}
				>
					<button
						type="button"
						className="footer-icon-button"
						id="remoteControlButton"
						aria-label={t("remoteControl")}
						aria-disabled="true"
					>
						<Icon name="phone" size="md" />
					</button>
				</Tooltip>
				<Tooltip
					id="settingsButtonTip"
					className="footer-tooltip compact"
					content={<strong>{t("settings")}</strong>}
				>
					<button
						type="button"
						className="footer-icon-button"
						id="settingsButton"
						aria-label={t("settings")}
						onClick={() => openSettings()}
					>
						<Icon name="cog" size="md" />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
