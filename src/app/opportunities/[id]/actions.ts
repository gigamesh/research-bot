"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

const ALLOWED = new Set(["candidate", "promoted", "snoozed", "dismissed"]);

export async function setStatus(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !ALLOWED.has(status)) return;
  await prisma.opportunity.update({
    where: { id },
    data: { status },
  });
  revalidatePath(`/opportunities/${id}`);
  revalidatePath("/");
  redirect(`/opportunities/${id}`);
}
