import { Layers } from "lucide-react";
import { ScrollLayout } from "@/components/layout/ScrollLayout";
import { EmptyState } from "@/components/shared/EmptyState";
import { LineupEncounters } from "@/components/teams/LineupEncounters";
import { LineupTemplates } from "@/components/teams/LineupTemplates";
import { useLanguage } from "@/contexts/LanguageContext";
import { useLineupStore } from "@/stores/useLineupStore";

export function LineupsView() {
  const { t } = useLanguage();
  const isEmpty = useLineupStore(
    (s) => s.encounters.length === 0 && s.templates.length === 0
  );

  return (
    <ScrollLayout>
      <div className="flex flex-col gap-4 py-2">
        {isEmpty && (
          <EmptyState
            icon={Layers}
            iconColor="text-primary"
            glowColor="bg-primary/15"
            title={t.ui("teamComp.tabLineups")}
            description={t.ui("lineup.emptyDesc")}
          />
        )}
        <LineupEncounters />
        <LineupTemplates />
      </div>
    </ScrollLayout>
  );
}
