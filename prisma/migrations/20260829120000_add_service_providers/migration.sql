-- CreateTable
CREATE TABLE "service_providers" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_providers_pkey" PRIMARY KEY ("id")
);
