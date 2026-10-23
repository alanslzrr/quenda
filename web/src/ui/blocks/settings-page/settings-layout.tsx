import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { UserRound } from "lucide-react";
import styles from "./settings-page.module.css";
export function SettingsLayout({ title, email, links, children }: { title: string; email: string; links: {to:string;label:string;icon:ReactNode}[]; children:ReactNode }) {
  return <div className={styles.root}><div className={styles.settings}>
    <aside className={styles.sidebar}><div className={styles.sidebarHead}><h2>{title}</h2></div>
      <nav aria-label={title}><ul className={styles.navList}>{links.map(link=><li key={link.to}><NavLink end to={link.to} className={styles.navItem}>{link.icon}<span className={styles.navLabel}>{link.label}</span></NavLink></li>)}</ul></nav>
      <div className={styles.account}><UserRound size={18} aria-hidden="true"/><span><strong>{email}</strong></span></div>
    </aside><div className={styles.main}><div className={styles.scroller}>{children}</div></div>
  </div></div>;
}
