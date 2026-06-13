update events set ignore_reason = 'FORCED'
where (originagenda_title like 'DataTourisme%'
or originagenda_title in ('OpenAgenda : Espaces Naturels Métropolitains','TicketMaster', 'Espaces Naturels Métropolitains',
'OpenAgenda : Ville de Wattrelos', 'OpenAgenda : Ville de Roubaix', 'OpenAgenda : Ville de Hellemmes', 'OpenAgenda : Ville de Villeneuve d''Ascq', 'OpenAgenda : Médiathèques de la Haute Deûle', 'OpenAgenda : Ville de Comines' , 'OpenAgenda : Mairie de Wattignies', 'OpenAgenda : Les Belles Sorties', 'OpenAgenda : Ville de Wambrechies', 'OpenAgenda : Ville de Lezennes', 'OpenAgenda : Ville de Lille', 'OpenAgenda : Les Nuits des bibliothèques', 'OpenAgenda : Médiathèque de Wattrelos','OpenAgenda : Nature à Lille'
))
and is_ignored = 'true' and ignore_reason = 'Hors zone géographique cible (Détection IA)'

update events set is_ignored = false where ignore_reason = 'FORCED'