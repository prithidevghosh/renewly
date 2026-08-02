import { redirect } from "next/navigation";

export default async function LoginRedirect({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams({ mode: "login" });
  if (params.error) query.set("error", params.error);
  redirect(`/onboarding?${query.toString()}`);
}
