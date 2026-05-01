import { cookies } from "next/headers";
import { getUserFromToken, COOKIE_NAME } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/mail/AppHeader";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const user = await getUserFromToken(token);
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <AppHeader email={user.email} />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
